package org.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.*;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Second independent listener on the same exchange as consumer_editorsdb.
 * Projects editors_db into home_page — a flat, body-less read model for
 * the homepage/list view only. No content_blocks, no rendering: this
 * listener only ever touches scalar columns plus lead_image_url.
 *
 * Fan-out is free here: same exchange (editors_db.events), a second
 * independent queue bound to it. This listener knows nothing about
 * EditorsDisplaySync and vice versa — that's the point.
 *
 * slug is the one exception to "knows nothing about EditorsDisplaySync":
 * buildSlug()/slugify() below are a deliberate byte-for-byte duplicate of
 * EditorsDisplaySync's, so both listeners independently compute the same
 * slug for the same editors_db row with no coordination, no DB round-trip,
 * and no dependency on which listener processes a given message first.
 *
 * CONNECTION LIFECYCLE — this listener is idle for long stretches between
 * editorial saves, which is exactly the shape that MariaDB's wait_timeout
 * kills. It therefore holds a pooled DataSource, NOT a single long-lived
 * java.sql.Connection: a connection is borrowed per message and returned
 * immediately. Hikari retires connections before the server would reap
 * them (maxLifetime < wait_timeout) and validates on borrow, so a reaped
 * or network-dropped connection is replaced transparently instead of
 * bricking the process until restart.
 *
 * Run: java -jar homepage-sync-0.0.1.jar
 * Config: RABBIT_HOST, RABBIT_PORT, RABBIT_USER, RABBIT_PASS, JDBC_URL as
 * env vars. DB credentials are NOT env vars — loaded from ~/.env
 * (PWUSER / PWPWD) instead, see loadDotEnv() below.
 */
public class HomePageSync {

    private static final String EXCHANGE = "editors_db.events";
    private static final String QUEUE = "home_page.sync";
    private static final String ROUTING_KEY = "editors_db.#";

    private static final ObjectMapper mapper = new ObjectMapper();

    private final DataSource ds;

    public HomePageSync(DataSource ds) {
        this.ds = ds;
    }

    public static void main(String[] args) throws Exception {
        String rabbitHost = env("RABBIT_HOST", "localhost");
        int rabbitPort = Integer.parseInt(env("RABBIT_PORT", "5672"));
        String rabbitUser = env("RABBIT_USER", "guest");
        String rabbitPass = env("RABBIT_PASS", "guest");

//        String jdbcUrl = env("JDBC_URL", "jdbc:mariadb://192.168.123.72:3306/phoenix_web"); 123.189
//        String jdbcUrl = env("JDBC_URL", "jdbc:mariadb://192.168.0.176:3306/phoenix_web");
//        String jdbcUrl = env("JDBC_URL", "jdbc:mariadb://192.168.123.189:3306/phoenix_web");
        String jdbcUrl = env("JDBC_URL", "jdbc:mariadb://192.168.123.214:3306/phoenix_web");

        Map<String, String> dotenv = loadDotEnv();
        String dbUser = dotenv.get("PWUSER");
        String dbPass = dotenv.get("PWPWD");

        if (dbUser == null || dbPass == null) {
            throw new IllegalStateException(
                    "PWUSER and/or PWPWD not found in ~/.env — refusing to connect without credentials.");
        }

        HikariDataSource ds = buildDataSource(jdbcUrl, dbUser, dbPass);
        Runtime.getRuntime().addShutdownHook(new Thread(ds::close));

        HomePageSync sync = new HomePageSync(ds);

        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost(rabbitHost);
        factory.setPort(rabbitPort);
        factory.setUsername(rabbitUser);
        factory.setPassword(rabbitPass);
        factory.setAutomaticRecoveryEnabled(true);

        com.rabbitmq.client.Connection rabbit = factory.newConnection("homepage-sync");
        Channel channel = rabbit.createChannel();

        channel.exchangeDeclare(EXCHANGE, "topic", true);
        channel.queueDeclare(QUEUE, true, false, false, null);
        channel.queueBind(QUEUE, EXCHANGE, ROUTING_KEY);
        channel.basicQos(1);

        System.out.println("[homepage-sync] listening on " + QUEUE + " (" + ROUTING_KEY + ")");

        DeliverCallback onMessage = (consumerTag, delivery) -> {
            long deliveryTag = delivery.getEnvelope().getDeliveryTag();
            try {
                JsonNode msg = mapper.readTree(delivery.getBody());
                long editorsDbId = msg.get("id").asLong();
                String op = msg.hasNonNull("op") ? msg.get("op").asText() : "upsert";
                if ("delete".equals(op)) {
                    sync.deleteOne(editorsDbId);
                } else {
                    sync.syncOne(editorsDbId);
                }
                channel.basicAck(deliveryTag, false);
            } catch (Exception e) {
                System.err.println("[homepage-sync] failed on message, requeueing once: " + e);
                boolean alreadyRedelivered = delivery.getEnvelope().isRedeliver();
                channel.basicNack(deliveryTag, false, !alreadyRedelivered);
            }
        };

        channel.basicConsume(QUEUE, false, onMessage, tag -> {});

        Thread.currentThread().join();
    }

    // ------------------------------------------------------------------
    //  pool
    // ------------------------------------------------------------------

    /**
     * maxLifetime must stay comfortably BELOW the server's wait_timeout so
     * Hikari retires a connection before MariaDB reaps it — otherwise the
     * pool hands out a corpse and the borrow fails. 280s is safe against
     * even an aggressive 300s server default; raise it only in step with
     * a verified wait_timeout (SHOW VARIABLES LIKE 'wait_timeout').
     *
     * minimumIdle=0 because this listener is bursty: between editorial
     * saves there is no reason to hold an open connection at all, which
     * removes the idle-reap failure mode by construction rather than by
     * timing.
     */
    private static HikariDataSource buildDataSource(String jdbcUrl, String user, String pass) {
        HikariConfig cfg = new HikariConfig();
        cfg.setPoolName("homepage-sync-pool");
        cfg.setJdbcUrl(jdbcUrl);
        cfg.setUsername(user);
        cfg.setPassword(pass);

        cfg.setMaximumPoolSize(2);        // one consumer thread + basicQos(1)
        cfg.setMinimumIdle(0);
//        cfg.setMaxLifetime(280_000);      // < server wait_timeout
        cfg.setMaxLifetime(1_800_000);
        cfg.setKeepaliveTime(120_000);    // defeats NAT/firewall idle drops
        cfg.setIdleTimeout(60_000);
        cfg.setConnectionTimeout(10_000);
        cfg.setValidationTimeout(5_000);
        cfg.setAutoCommit(true);          // was db.setAutoCommit(true)

        cfg.addDataSourceProperty("tcpKeepAlive", "true");
        cfg.addDataSourceProperty("socketTimeout", "60000");
        cfg.addDataSourceProperty("connectTimeout", "10000");

        return new HikariDataSource(cfg);
    }

    private static String env(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? fallback : v;
    }

    /** Minimal ~/.env parser — KEY=VALUE per line, '#' comments, blank
     *  lines skipped, surrounding single/double quotes on the value
     *  stripped. No dependency added for this; the file is tiny. */
    private static Map<String, String> loadDotEnv() throws Exception {
        Map<String, String> values = new HashMap<>();
        Path path = Path.of(System.getProperty("user.home"), ".env");
        if (!Files.exists(path)) {
            System.err.println("[homepage-sync] no ~/.env found at " + path);
            return values;
        }
        List<String> lines = Files.readAllLines(path);
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
            int eq = trimmed.indexOf('=');
            if (eq < 0) continue;
            String key = trimmed.substring(0, eq).trim();
            String value = trimmed.substring(eq + 1).trim();
            if (value.length() >= 2 &&
                    ((value.startsWith("\"") && value.endsWith("\"")) ||
                            (value.startsWith("'") && value.endsWith("'")))) {
                value = value.substring(1, value.length() - 1);
            }
            values.put(key, value);
        }
        return values;
    }

    // ------------------------------------------------------------------
    //  one row, plain upsert — no derived fields, no diffing
    // ------------------------------------------------------------------

    public void syncOne(long editorsDbId) throws Exception {
        // Single borrow for both the read and the write: the SELECT and the
        // upsert stay on one connection, so they see one consistent server
        // session, and the connection is returned the moment we're done.
        try (Connection db = ds.getConnection()) {
            Row src = fetchRow(db, editorsDbId);
            if (src == null) {
                System.err.println("[homepage-sync] editors_db id=" + editorsDbId + " not found, skipping");
                return;
            }

            String slug = buildSlug(src.title, src.id);

            // slug is deliberately left OUT of the ON DUPLICATE KEY UPDATE list:
            // it's set once, on first insert (VALUES(...) branch), and frozen
            // after that — same as article_display's slug — so a link already
            // generated from home_page never points at a slug that's since
            // changed underneath it.
            try (PreparedStatement ps = db.prepareStatement(
                    "INSERT INTO home_page " +
                            "(id, title, dek, author, category, date_time, section_zone, intra_section_zone, cover_media_url, slug) " +
                            "VALUES (?,?,?,?,?,?,?,?,?,?) " +
                            "ON DUPLICATE KEY UPDATE " +
                            "  title=VALUES(title), dek=VALUES(dek), author=VALUES(author), " +
                            "  category=VALUES(category), date_time=VALUES(date_time), " +
                            "  section_zone=VALUES(section_zone), intra_section_zone=VALUES(intra_section_zone), " +
                            "  cover_media_url=VALUES(cover_media_url)")) {
                ps.setLong(1, src.id);
                ps.setString(2, src.title);
                ps.setString(3, src.summary);       // -> dek
                ps.setString(4, src.author);
                ps.setString(5, src.category);
                ps.setTimestamp(6, src.dateTime);
                ps.setString(7, src.sectionZone);
                if (src.intraSectionZone != null) ps.setInt(8, src.intraSectionZone);
                else ps.setNull(8, java.sql.Types.TINYINT);
                ps.setString(9, src.leadImageUrl);  // -> cover_media_url
                ps.setString(10, slug);
                ps.executeUpdate();
            }
        }
    }

    //---deletion method
    public void deleteOne(long editorsDbId) throws Exception {
        try (Connection db = ds.getConnection();
             PreparedStatement ps = db.prepareStatement(
                     "DELETE FROM home_page WHERE id = ?")) {
            ps.setLong(1, editorsDbId);
            int deleted = ps.executeUpdate();
            if (deleted == 0) {
                System.err.println("[homepage-sync] delete for editors_db id=" + editorsDbId +
                        " — no matching home_page row");
            }
        }
    }

    // Takes the borrowed Connection rather than reading a field, so the
    // caller owns the borrow/return for the whole unit of work.
    private Row fetchRow(Connection db, long id) throws Exception {
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT id, title, summary, author, category, date_time, " +
                        "section_zone, intra_section_zone, lead_image_url " +
                        "FROM editors_db WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                Integer intraZone = (Integer) rs.getObject("intra_section_zone");
                return new Row(
                        rs.getLong("id"), rs.getString("title"), rs.getString("summary"),
                        rs.getString("author"), rs.getString("category"), rs.getTimestamp("date_time"),
                        rs.getString("section_zone"), intraZone, rs.getString("lead_image_url")
                );
            }
        }
    }

    // Byte-for-byte identical to EditorsDisplaySync's buildSlug()/slugify()
    // — see that file's comment on why this is deterministic and safely
    // duplicated rather than shared.
    /*bruv the slug is literally built with id. no mistake. i argue
     * that a pure slug no id format would be preferred.*/
    private static String buildSlug(String title, long editorsDbId) {
        return slugify(title);
    }

    private static String slugify(String title) {
        if (title == null || title.isBlank()) return "article";
        String s = title.toLowerCase(Locale.ROOT).trim();
        s = s.replaceAll("[^a-z0-9\\u4e00-\\u9fa5]+", "-");
        s = s.replaceAll("(^-+|-+$)", "");
        if (s.length() > 180) s = s.substring(0, 180);
        return s.isEmpty() ? "article" : s;
    }

    private record Row(
            long id, String title, String summary, String author, String category,
            Timestamp dateTime, String sectionZone, Integer intraSectionZone, String leadImageUrl
    ) {}
}
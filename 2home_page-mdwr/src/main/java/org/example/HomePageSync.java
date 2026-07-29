package org.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
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

    private final Connection db;

    public HomePageSync(Connection db) {
        this.db = db;
    }

    public static void main(String[] args) throws Exception {
        String rabbitHost = env("RABBIT_HOST", "localhost");
        int rabbitPort = Integer.parseInt(env("RABBIT_PORT", "5672"));
        String rabbitUser = env("RABBIT_USER", "guest");
        String rabbitPass = env("RABBIT_PASS", "guest");

        String jdbcUrl = env("JDBC_URL", "jdbc:mysql://192.168.123.72:3306/phoenix_web");

        Map<String, String> dotenv = loadDotEnv();
        String dbUser = dotenv.get("PWUSER");
        String dbPass = dotenv.get("PWPWD");

        if (dbUser == null || dbPass == null) {
            throw new IllegalStateException(
                    "PWUSER and/or PWPWD not found in ~/.env — refusing to connect without credentials.");
        }

        Connection db = DriverManager.getConnection(jdbcUrl, dbUser, dbPass);
        db.setAutoCommit(true);
        HomePageSync sync = new HomePageSync(db);

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
                sync.syncOne(editorsDbId);
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
        Row src = fetchRow(editorsDbId);
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

    private Row fetchRow(long id) throws Exception {
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
    private static String buildSlug(String title, long editorsDbId) {
        return slugify(title) + "-" + editorsDbId;
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
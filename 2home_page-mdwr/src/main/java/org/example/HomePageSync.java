package org.example;



import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.*;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;

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
 * Run: java -jar homepage-sync-0.0.1.jar
 * Config: same five env vars as consumer_editorsdb (RABBIT_HOST,
 * RABBIT_PORT, RABBIT_USER, RABBIT_PASS, JDBC_URL/DB_USER/DB_PASS).
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
        String dbUser = env("DB_USER", "remote_user");
        String dbPass = env("DB_PASS", "pstv1688");

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

    // ------------------------------------------------------------------
    //  one row, plain upsert — no derived fields, no diffing
    // ------------------------------------------------------------------

    public void syncOne(long editorsDbId) throws Exception {
        Row src = fetchRow(editorsDbId);
        if (src == null) {
            System.err.println("[homepage-sync] editors_db id=" + editorsDbId + " not found, skipping");
            return;
        }

        try (PreparedStatement ps = db.prepareStatement(
                "INSERT INTO home_page " +
                        "(id, title, dek, author, category, date_time, section_zone, intra_section_zone, cover_media_url) " +
                        "VALUES (?,?,?,?,?,?,?,?,?) " +
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

    private record Row(
            long id, String title, String summary, String author, String category,
            Timestamp dateTime, String sectionZone, Integer intraSectionZone, String leadImageUrl
    ) {}
}
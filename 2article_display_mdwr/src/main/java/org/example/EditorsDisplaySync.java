package org.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.rabbitmq.client.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.*;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import java.sql.Connection;

/**
 * Standalone listener: subscribes to editors_db.events (published by
 * writer_back's EditorsDbEventPublisher after each successful ingest())
 * and projects the changed row into article_display. No Spring, no
 * JdbcTemplate — plain JDBC, one Connection held for the process's life.
 *
 * Run: java -jar editors-display-sync-0.0.1.jar
 * Config: five env vars, see main() below. No config file, no profiles —
 * matches the rest of this project's "no more machinery than the task
 * needs" style.
 *
 * Same content-shape gap as before: editors_db has no alt/credit columns
 * for lead image or inline media, so those stay NULL in article_display
 * until the ingest editor captures them. See renderProseMirror()'s doc
 * comment for the node/mark coverage this depends on.
 */
public class EditorsDisplaySync {

    private static final String EXCHANGE = "editors_db.events";
    private static final String QUEUE = "article_display.sync";
    // "#" = every routing key under editors_db.* (insert and update both).
    // Narrow this to "editors_db.update" etc. if a future consumer only
    // cares about one op.
    private static final String ROUTING_KEY = "editors_db.#";

    private static final ObjectMapper mapper = new ObjectMapper();
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]*>");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final int WORDS_PER_MINUTE = 200;

    private final java.sql.Connection db;


    public EditorsDisplaySync(java.sql.Connection db)  {
        this.db = db;
    }

    public static void main(String[] args) throws Exception {
        String rabbitHost = env("RABBIT_HOST", "localhost");
        int rabbitPort = Integer.parseInt(env("RABBIT_PORT", "5672"));
        String rabbitUser = env("RABBIT_USER", "guest");
        String rabbitPass = env("RABBIT_PASS", "guest");

//        String jdbcUrl = env("JDBC_URL", "jdbc:mysql://192.168.123.72:3306/phoenix_web");

//        String jdbcUrl = env("JDBC_URL", "jdbc:mysql://192.168.0.176:3306/phoenix_web");
        String jdbcUrl = env("JDBC_URL", "jdbc:mysql://192.168.123.189:3306/phoenix_web");
        Map<String, String> dotenv = loadDotEnv();
        String dbUser = dotenv.get("PWUSER");
        String dbPass = dotenv.get("PWPWD");
        System.out.println(dbUser);
        System.out.println(dbPass);
        if (dbUser == null || dbPass == null) {
            throw new IllegalStateException(
                    "PWUSER and/or PWPWD not found in ~/.env — refusing to connect without credentials.");
        }
        System.out.println("Connecting to: " + jdbcUrl);
        Connection db = DriverManager.getConnection(jdbcUrl, dbUser, dbPass);
        db.setAutoCommit(true);
        EditorsDisplaySync sync = new EditorsDisplaySync(db);

        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost(rabbitHost);
        factory.setPort(rabbitPort);
        factory.setUsername(rabbitUser);
        factory.setPassword(rabbitPass);
        factory.setAutomaticRecoveryEnabled(true); // reconnects on broker blips

        com.rabbitmq.client.Connection rabbit = factory.newConnection("editors-display-sync");
        Channel channel = rabbit.createChannel();

        channel.exchangeDeclare(EXCHANGE, "topic", true);
        channel.queueDeclare(QUEUE, /* durable */ true, false, false, null);
        channel.queueBind(QUEUE, EXCHANGE, ROUTING_KEY);
        // Process one message at a time before acking the next — with a
        // single JDBC connection that's the right prefetch; raise this
        // only alongside a connection pool.
        channel.basicQos(1);

        System.out.println("[sync] listening on " + QUEUE + " (" + ROUTING_KEY + ")");

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
                System.err.println("[sync] failed on message, requeueing once: " + e);
                // requeue=false on redelivery would need a redelivery-count
                // check to avoid an infinite loop; simplest safe default
                // here is: requeue once, then let it dead-letter if your
                // queue has a DLX configured. No DLX is set up above —
                // add one before relying on this in production.
                boolean alreadyRedelivered = delivery.getEnvelope().isRedeliver();
                channel.basicNack(deliveryTag, false, !alreadyRedelivered);
            }
        };



        channel.basicConsume(QUEUE, /* autoAck */ false, onMessage, tag -> {});

        // keep the process alive; basicConsume runs on its own thread
        Thread.currentThread().join();
    }

    private static String env(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? fallback : v;
    }

    //    helper for env file
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
    //  one row, plain JDBC
    // ------------------------------------------------------------------

    public void syncOne(long editorsDbId) throws SQLException {
        EditorsRow src = fetchRow(editorsDbId);
        if (src == null) {
            System.err.println("[sync] editors_db id=" + editorsDbId + " not found, skipping");
            return;
        }

        ArrayNode displayBlocks = transformBlocks(src.contentBlocks);
        if (displayBlocks == null) {
            System.err.println("[sync] editors_db id=" + editorsDbId +
                    " has invalid content_blocks JSON, skipping");
            return;
        }

        String blocksJson;
        try {
            blocksJson = mapper.writeValueAsString(displayBlocks);
        } catch (Exception e) {
            System.err.println("[sync] editors_db id=" + editorsDbId + " failed to serialize: " + e);
            return;
        }

        int wordCount = countWords(displayBlocks);
        int readingMinutes = Math.max(1, (int) Math.ceil(wordCount / (double) WORDS_PER_MINUTE));

        boolean hasLead = src.leadImageUrl != null && !src.leadImageUrl.isBlank();
        String leadUrl = hasLead ? src.leadImageUrl : null;
        String leadCaption = hasLead ? src.leadImageCaption : null;

        Long existingId = null;
        String priorBlocksJson = null;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT id, content_blocks FROM article_display WHERE editors_db_id = ?")) {
            ps.setLong(1, editorsDbId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    existingId = rs.getLong("id");
                    priorBlocksJson = rs.getString("content_blocks");
                }
            }
        }

        boolean blocksChanged = existingId != null && priorBlocksJson != null
                && !normalizeForCompare(priorBlocksJson).equals(normalizeForCompare(blocksJson));

        if (existingId == null) {
            String slug = buildSlug(src.title, editorsDbId);
            // MariaDB has no CAST(... AS JSON) — that's MySQL-only syntax.
            // content_blocks is a JSON-aliased LONGTEXT column here, so a
            // plain string bind is all that's needed; MariaDB validates it
            // against JSON_VALID() itself.
            try (PreparedStatement ps = db.prepareStatement(
                    "INSERT INTO article_display " +
                            "(slug, editors_db_id, headline, dek, category, author_name, " +
                            " published_at, revised_at, lead_image_url, lead_image_alt, " +
                            " lead_image_caption, lead_image_credit, content_blocks, state, " +
                            " word_count, reading_time_minutes) " +
                            "VALUES (?,?,?,?,?,?,?,NULL,?,NULL,?,NULL,?,'published',?,?)")) {
                ps.setString(1, slug);
                ps.setLong(2, editorsDbId);
                ps.setString(3, src.title);
                ps.setString(4, src.summary);
                ps.setString(5, src.category);
                ps.setString(6, src.author);
                ps.setTimestamp(7, src.dateTime);
                ps.setString(8, leadUrl);
                ps.setString(9, leadCaption);
                ps.setString(10, blocksJson);
                ps.setInt(11, wordCount);
                ps.setInt(12, readingMinutes);
                ps.executeUpdate();
            }
        } else if (blocksChanged) {
            try (PreparedStatement ps = db.prepareStatement(
                    "UPDATE article_display SET " +
                            " headline=?, dek=?, category=?, author_name=?, " +
                            " lead_image_url=?, lead_image_caption=?, " +
                            " content_blocks=?, word_count=?, reading_time_minutes=?, revised_at=? " +
                            "WHERE editors_db_id=?")) {
                ps.setString(1, src.title);
                ps.setString(2, src.summary);
                ps.setString(3, src.category);
                ps.setString(4, src.author);
                ps.setString(5, leadUrl);
                ps.setString(6, leadCaption);
                ps.setString(7, blocksJson);
                ps.setInt(8, wordCount);
                ps.setInt(9, readingMinutes);
                ps.setTimestamp(10, Timestamp.from(java.time.Instant.now()));
                ps.setLong(11, editorsDbId);
                ps.executeUpdate();
            }
        } else {
            try (PreparedStatement ps = db.prepareStatement(
                    "UPDATE article_display SET " +
                            " headline=?, dek=?, category=?, author_name=?, lead_image_url=?, lead_image_caption=? " +
                            "WHERE editors_db_id=?")) {
                ps.setString(1, src.title);
                ps.setString(2, src.summary);
                ps.setString(3, src.category);
                ps.setString(4, src.author);
                ps.setString(5, leadUrl);
                ps.setString(6, leadCaption);
                ps.setLong(7, editorsDbId);
                ps.executeUpdate();
            }
        }
    }

    //---deletion method
    public void deleteOne(long editorsDbId) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "DELETE FROM article_display WHERE editors_db_id = ?")) {
            ps.setLong(1, editorsDbId);
            int deleted = ps.executeUpdate();
            if (deleted == 0) {
                System.out.println("[sync] delete for editors_db id=" + editorsDbId +
                        " — no matching article_display row");
            }
        }
    }

    private EditorsRow fetchRow(long id) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT id, title, summary, author, category, date_time, " +
                        "lead_image_url, lead_image_caption, content_blocks " +
                        "FROM editors_db WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                return new EditorsRow(
                        rs.getLong("id"), rs.getString("title"), rs.getString("summary"),
                        rs.getString("author"), rs.getString("category"), rs.getTimestamp("date_time"),
                        rs.getString("lead_image_url"), rs.getString("lead_image_caption"),
                        rs.getString("content_blocks")
                );
            }
        }
    }

    // ------------------------------------------------------------------
    //  editors_db BlockDTO -> display block shape (identical to the
    //  earlier Spring version — see that file's comments for why each
    //  node/mark case exists)
    // ------------------------------------------------------------------

    private ArrayNode transformBlocks(String raw) {
        ArrayNode out = mapper.createArrayNode();
        if (raw == null || raw.isBlank()) return out;
        JsonNode dtos;
        try {
            dtos = mapper.readTree(raw);
        } catch (Exception e) {
            return null;
        }
        if (!dtos.isArray()) return null;

        for (JsonNode dto : dtos) {
            String type = textOrNull(dto, "type");
            if (type == null) continue;
            ObjectNode block = mapper.createObjectNode();
            if (type.equals("paragraph")) {
                JsonNode contentJson = dto.get("content_json");
                block.put("type", "paragraph");
                block.put("html", contentJson != null && !contentJson.isNull()
                        ? renderProseMirror(contentJson) : "");
            } else if (type.equals("image") || type.equals("video")) {
                block.put("type", type);
                block.put("url", textOrNull(dto, "media_url"));
                block.putNull("alt");
                String caption = textOrNull(dto, "caption");
                if (caption == null) block.putNull("caption"); else block.put("caption", caption);
                block.putNull("credit");
            } else {
                continue;
            }
            out.add(block);
        }
        return out;
    }

    private String textOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    /** ProseMirror JSON -> HTML. Covers doc, paragraph, heading(1-6 -> h2/h3),
     *  bulletList, orderedList, listItem, blockquote, codeBlock, hardBreak,
     *  text + marks bold/italic/underline/strike/link — exactly StarterKit +
     *  Underline + Link, matching the ingest editor's Tiptap extensions.
     *  Add a Tiptap extension, add a case here, or that content silently
     *  drops out of the rendered HTML. */
    private String renderProseMirror(JsonNode node) {
        StringBuilder sb = new StringBuilder();
        renderNode(node, sb);
        return sb.toString();
    }

    private void renderNode(JsonNode node, StringBuilder sb) {
        if (node == null || node.isNull()) return;
        String type = textOrNull(node, "type");
        if (type == null) { renderChildren(node, sb); return; }
        switch (type) {
            case "doc" -> renderChildren(node, sb);
            case "paragraph" -> wrap(sb, "p", node);
            case "heading" -> {
                int level = node.has("attrs") && node.get("attrs").has("level")
                        ? node.get("attrs").get("level").asInt(1) : 1;
                wrap(sb, level <= 1 ? "h2" : "h3", node);
            }
            case "bulletList" -> wrap(sb, "ul", node);
            case "orderedList" -> wrap(sb, "ol", node);
            case "listItem" -> wrap(sb, "li", node);
            case "blockquote" -> wrap(sb, "blockquote", node);
            case "codeBlock" -> { sb.append("<pre><code>"); renderChildren(node, sb); sb.append("</code></pre>"); }
            case "hardBreak" -> sb.append("<br>");
            case "text" -> renderText(node, sb);
            default -> renderChildren(node, sb);
        }
    }

    private void wrap(StringBuilder sb, String tag, JsonNode node) {
        sb.append('<').append(tag).append('>');
        renderChildren(node, sb);
        sb.append("</").append(tag).append('>');
    }

    private void renderChildren(JsonNode node, StringBuilder sb) {
        JsonNode content = node.get("content");
        if (content == null || !content.isArray()) return;
        for (JsonNode child : content) renderNode(child, sb);
    }

    private void renderText(JsonNode node, StringBuilder sb) {
        String text = escapeHtml(textOrNull(node, "text"));
        if (text == null) return;
        StringBuilder open = new StringBuilder();
        StringBuilder close = new StringBuilder();
        String linkHref = null;
        JsonNode marks = node.get("marks");
        if (marks != null && marks.isArray()) {
            for (JsonNode mark : marks) {
                String mType = textOrNull(mark, "type");
                if (mType == null) continue;
                switch (mType) {
                    case "bold" -> { open.append("<strong>"); close.insert(0, "</strong>"); }
                    case "italic" -> { open.append("<em>"); close.insert(0, "</em>"); }
                    case "underline" -> { open.append("<u>"); close.insert(0, "</u>"); }
                    case "strike" -> { open.append("<s>"); close.insert(0, "</s>"); }
                    case "link" -> {
                        JsonNode attrs = mark.get("attrs");
                        linkHref = attrs != null ? textOrNull(attrs, "href") : null;
                    }
                    default -> { }
                }
            }
        }
        if (linkHref != null) {
            sb.append("<a href=\"").append(escapeHtml(linkHref)).append("\">")
                    .append(open).append(text).append(close).append("</a>");
        } else {
            sb.append(open).append(text).append(close);
        }
    }

    private String escapeHtml(String s) {
        if (s == null) return null;
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private int countWords(ArrayNode blocks) {
        StringBuilder text = new StringBuilder();
        for (JsonNode block : blocks) {
            if ("paragraph".equals(textOrNull(block, "type"))) {
                String html = textOrNull(block, "html");
                if (html != null) text.append(HTML_TAG.matcher(html).replaceAll(" ")).append(' ');
            }
        }
        String plain = WHITESPACE.matcher(text.toString()).replaceAll(" ").trim();
        return plain.isEmpty() ? 0 : plain.split(" ").length;
    }

    private String normalizeForCompare(String json) {
        try {
            return mapper.writeValueAsString(mapper.readTree(json));
        } catch (Exception e) {
            return json;
        }
    }

    // Deterministic — pure function of (title, editorsDbId), no DB lookup.
    // editorsDbId is already globally unique (editors_db auto-increment PK),
    // so always suffixing it guarantees a unique slug with zero collision
    // risk, and lets HomePageSync compute the exact same string on its own
    // without either listener knowing about the other or needing any
    // message-ordering guarantee between them.
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

    private record EditorsRow(
            long id, String title, String summary, String author, String category,
            Timestamp dateTime, String leadImageUrl, String leadImageCaption, String contentBlocks
    ) {}
}
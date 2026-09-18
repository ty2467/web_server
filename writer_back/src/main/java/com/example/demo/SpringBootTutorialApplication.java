package org.example.springboottutorial;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;  
import org.springframework.http.ResponseEntity;

import org.springframework.core.io.InputStreamResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import java.io.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.http.ResponseEntity;

// Java NIO for modern file path and filesystem operations
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

// Java IO for streaming and assembling the 15GB file
import java.io.OutputStream;
import java.io.BufferedOutputStream;

import java.util.concurrent.locks.ReentrantLock;
import org.springframework.dao.DuplicateKeyException;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import static org.springframework.security.config.Customizer.withDefaults;

import org.springframework.context.annotation.Bean;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;


/* foreign key handler*/
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.transaction.annotation.Transactional;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.sql.Timestamp;

// Jackson 3 — the version Spring Boot 4 ships and auto-configures. Used for
// the content_blocks JSON column round-trip (Java <-> JSON string at the
// JDBC boundary). Same mapper Spring uses for HTTP, injected rather than
// hand-built, so there's exactly one Jackson on the classpath.
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.core.type.TypeReference;

@SpringBootApplication
@RestController
@CrossOrigin(origins = "*")
/**
 * editors_db is the write model for this CMS (one row per article,
 * content_blocks holds the full block array — every paragraph's Tiptap
 * JSON, every image/video url, caption, and alignment, in the order the
 * editor arranged them). It's intentionally separate from news_articles
 * and its child tables, which are the read model serving the public site.
 * Nothing here writes to news_articles; that's a different pipeline's job.
 */

public class SpringBootTutorialApplication {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    // Spring Boot 4 auto-configures a JsonMapper (Jackson 3) — inject it
    // rather than building one, so HTTP and DB serialization share exactly
    // one configured mapper.
    @Autowired
    private JsonMapper jsonMapper;

    
    @Autowired
    private EditorsDbEventPublisher eventPublisher; 	
    // <input type="datetime-local"> sends/expects exactly "yyyy-MM-ddTHH:mm"
    // (seconds optional) — Java's default ISO_LOCAL_DATE_TIME parser matches
    // that format already, no custom pattern needed for parsing. Formatting
    // back out on read still needs an explicit pattern, since
    // Timestamp.toString() produces "yyyy-MM-dd HH:mm:ss.S" (space-
    // separated, fractional seconds) — not what the input element accepts.
    private static final DateTimeFormatter DATETIME_LOCAL_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");

    private Timestamp parseDateTimeLocal(String raw) {
        return Timestamp.valueOf(LocalDateTime.parse(raw));
    }

    private String formatDateTimeLocal(Timestamp ts) {
        return ts.toLocalDateTime().format(DATETIME_LOCAL_FORMAT);
    }


    @Value("${img_vid_root}")
    private String WEB_ROOT;


//    private String targetSubDir = "media";
    // Media is bucketed by month under the web root: ifengus/sep26/, ifengus/oct26/.
    // Computed per write, never cached — a long-running process must not keep
    // writing into last month's folder after the rollover.
    private String currentSubDir() {
        return java.time.LocalDate.now(java.time.ZoneId.of("America/Los_Angeles"))
                .format(DateTimeFormatter.ofPattern("MMMyy", java.util.Locale.ENGLISH))
                .toLowerCase();
    }

    public static void main(String[] args) {
        SpringApplication.run(SpringBootTutorialApplication.class, args);
    }


    private void deleteDirectoryRecursively(Path path) throws IOException {
        Files.walk(path)
                .sorted((a, b) -> b.compareTo(a))
                .forEach(p -> {
                    try { Files.delete(p); } catch (IOException e) { e.printStackTrace(); }
                });
    }



    /**
     * api for video writing.
     * @ temporary pieces then assemble.
     * @ concat public url
     * @ appends that public url for
     */
    /* video handler */
    @PostMapping("/api/ingest/video-chunk")
    public ResponseEntity<?> handleVideoChunk(
            @RequestParam("chunk") MultipartFile chunk,
            @RequestParam("chunkIndex") int chunkIndex,
            @RequestParam("totalChunks") int totalChunks,
            @RequestParam("fileName") String fileName) {

        // Define where to store temporary chunks
        String sanitizedDir = fileName.replaceAll("[^a-zA-Z0-9.-]", "_");
        Path uploadDir = Paths.get("uploads", sanitizedDir);

        /**
         * THIS FUNCTION REPEATEDLY GETS CALLED ANY
         * TIME ONE CHUNK COMES IN, WHICH FOR NOTING IS
         * ONE HTTP POST REQUEST.
         *
         * * THE URL DESTINATION. publicVideoURL. which is the one browser calls.
         * calling browser callible url construction helper method.
         * @writible url into sql: publicVideoUrl
         */

        try {
            if (!Files.exists(uploadDir)) {
                Files.createDirectories(uploadDir);
            }
            // Save part
            Path chunkPath = uploadDir.resolve(fileName + ".part" + chunkIndex);
            Files.write(chunkPath, chunk.getBytes());

            if (chunkIndex == totalChunks - 1) {
                String path = assembleFile(uploadDir, fileName, totalChunks);
                return ResponseEntity.ok(Map.of("message", "Assembly complete", "path", path));
            }
            //this is while not the last chunk.
            return ResponseEntity.accepted().body(Map.of("chunkIndex", chunkIndex));
        } catch (IOException e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    /** Builds and writes @: /opt/homebrew/var/www + media + filename */
    /** Writes WEB_ROOT/<month>/<fileName>; returns "<month>/<fileName>" for the client. */
    private String assembleFile(Path dir, String fileName, int totalChunks) throws IOException {
        String subDir = currentSubDir();
        Path finalPath = Paths.get(WEB_ROOT, subDir, fileName);
        Files.createDirectories(finalPath.getParent());

        try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(finalPath))) {
            for (int i = 0; i < totalChunks; i++) {
                Path partPath = dir.resolve(fileName + ".part" + i);
                Files.copy(partPath, out);
                Files.delete(partPath);
            }
        }

        deleteDirectoryRecursively(dir);
        return subDir + "/" + fileName;
    }


    /* image handler */
    @PostMapping("/api/ingest/image-upload")
    public ResponseEntity<?> handleImageUpload(@RequestParam("image") MultipartFile image) {
        String fileName = image.getOriginalFilename();
        if (fileName == null || fileName.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No filename provided"));
        }

        String subDir = currentSubDir();
        Path finalPath = Paths.get(WEB_ROOT, subDir, fileName);

        try {
            Files.createDirectories(finalPath.getParent());
            Files.copy(image.getInputStream(), finalPath,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            // The month folder is a server-side decision, so the client is
            // told where the file landed rather than guessing.
            return ResponseEntity.ok(Map.of("path", subDir + "/" + fileName));
        } catch (IOException e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * api for dashboard fetch and modify.
     * -> pull generic information.
     * * -> pull or delete specific data.
     */
    // --- Handler for Angular Dashboard (untouched — only the editor_db -> editors_db typo fix) ---
    @GetMapping("/api/articles/summary")
    public List<EditorialItemDTO> getArticleSummaries() {
        String sql = "SELECT id, title, date_time FROM editors_db ORDER BY date_time DESC";
        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            EditorialItemDTO item = new EditorialItemDTO();
            item.setId(rs.getLong("id"));
            item.setTitle(rs.getString("title"));
            // Converting SQL Timestamp to String for the TS interface
            item.setDate_time(rs.getTimestamp("date_time").toString());
            return item;
        });
    }


    // -- handler for article detail --
    @GetMapping("/api/articles/{id}")
    public ResponseEntity<ArticleRequest> getArticleDetail(@PathVariable Long id) {
        String sql = "SELECT * FROM editors_db WHERE id = ?";
        try {
            ArticleRequest article = jdbcTemplate.queryForObject(sql, (rs, rowNum) -> {
                ArticleRequest req = new ArticleRequest();
                req.setId(rs.getLong("id"));
                req.setTitle(rs.getString("title"));
                req.setSummary(rs.getString("summary"));
                req.setAuthor(rs.getString("author"));
                req.setCategory(rs.getString("category"));
                req.setDate_time(formatDateTimeLocal(rs.getTimestamp("date_time")));
                req.setSection_zone(rs.getString("section_zone"));
                req.setLead_image_url(rs.getString("lead_image_url"));
                req.setLead_image_caption(rs.getString("lead_image_caption"));
                req.setView_count(rs.getInt("view_count"));

                int intraZone = rs.getInt("intra_section_zone");
                req.setIntra_section_zone(rs.wasNull() ? null : intraZone);

                // One JSON column holds the whole block array — deserialize
                // it once, no per-row mapping and no re-sort needed (the
                // order the editor set is exactly the order stored).
                // Jackson 3's exceptions are unchecked, so this catches
                // RuntimeException rather than IOException.
                String blocksJson = rs.getString("content_blocks");
                if (blocksJson != null) {
                    try {
                        List<ContentBlock> blocks = jsonMapper.readValue(
                                blocksJson, new TypeReference<List<ContentBlock>>() {});
                        req.setContent_blocks(blocks);
                    } catch (RuntimeException e) {
                        req.setContent_blocks(new ArrayList<>());
                    }
                } else {
                    req.setContent_blocks(new ArrayList<>());
                }

                return req;
            }, id);

            return ResponseEntity.ok(article);
        } catch (Exception e) {
            // Return 404 if the article doesn't exist
            return ResponseEntity.notFound().build();
        }
    }

    @DeleteMapping("/api/delete")
    public ResponseEntity<?> deleteArticles(@RequestBody List<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No IDs provided for deletion"));
        }

        // One table, no children to clean up — a plain delete is enough now.
        String placeholders = String.join(",", ids.stream().map(id -> "?").toArray(String[]::new));
        String sql = String.format("DELETE FROM editors_db WHERE id IN (%s)", placeholders);

        try {
            int rowsAffected = jdbcTemplate.update(sql, ids.toArray());

            for (Long id : ids) {
                eventPublisher.publish(id, "delete");
            }

            return ResponseEntity.ok().body(Map.of(
                    "message", "Successfully deleted articles",
                    "count", rowsAffected
            ));
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.internalServerError().body(Map.of("error", "Database error during deletion: " + e.getMessage()));
        }
    }


    //    ------helper methods for ingest
    private static final java.util.Set<String> FRONTS =
            java.util.Set.of("main", "sub_main", "tertiary");
    private static final java.util.Set<String> ZONES =
            java.util.Set.of("main", "sub_main", "tertiary", "column");

    /**
     * The UI can't produce two fronts, so this isn't validation an editor
     * will ever hit — it's a guard against a hand-rolled POST. One member
     * outside the SET definition makes MariaDB reject the whole value, not
     * just that member, so unknowns are dropped rather than passed through.
     */
    private String normalizeSectionZone(String raw) {
        if (raw == null || raw.isBlank()) return null;
        java.util.LinkedHashSet<String> keep = new java.util.LinkedHashSet<>();
        boolean frontTaken = false;
        for (String part : raw.split(",")) {
            String z = part.trim();
            if (!ZONES.contains(z)) continue;
            if (FRONTS.contains(z)) {
                if (frontTaken) continue;
                frontTaken = true;
            }
            keep.add(z);
        }
        return keep.isEmpty() ? null : String.join(",", keep);
    }

    private boolean hasFront(String sectionZone) {
        if (sectionZone == null) return false;
        for (String z : sectionZone.split(",")) if (FRONTS.contains(z.trim())) return true;
        return false;
    }

    /**
     * ingest metadata + content_blocks (Tiptap JSON, media urls, captions,
     * alignment — everything the editor produced) as one row, one write.
     * @param article
     * @return
     */
    @PostMapping("/api/ingest")
    public ResponseEntity<?> ingest(@RequestBody ArticleRequest article) {
        Long articleId = article.getId();

        // Jackson 3 exceptions are unchecked, so no try/catch needed here —
        // a serialization failure falls through to the outer handler below.
        int viewCount = article.getView_count() == null || article.getView_count() < 0
                ? 0 : article.getView_count();

        List<ContentBlock> blocks = article.getContent_blocks() != null
                ? article.getContent_blocks() : new ArrayList<>();

        String blocksJson = jsonMapper.writeValueAsString(blocks);
        boolean isUpdate = articleId != null && articleId > 0;

        String sectionZone = normalizeSectionZone(article.getSection_zone());
        // 排列 belongs to a front. 栏目-only placement has no slot number,
        // and intra_section_zone is tinyint UNSIGNED — the old -1 sentinel
        // could never have stored anyway.
        if (!hasFront(sectionZone)) {
            article.setIntra_section_zone(null);
        }

        try {
            if (isUpdate) {
                String updateSql = "UPDATE editors_db SET title=?, summary=?, author=?, category=?, " +
                        "date_time=?, section_zone=?, intra_section_zone=?, lead_image_url=?, lead_image_caption=?, " +
                        "content_blocks=?, view_count=? WHERE id=?";
                jdbcTemplate.update(updateSql,
                        article.getTitle(), article.getSummary(), article.getAuthor(), article.getCategory(),
                        parseDateTimeLocal(article.getDate_time()), article.getSection_zone(),
                        article.getIntra_section_zone(), article.getLead_image_url(), article.getLead_image_caption(),
                        blocksJson, viewCount, articleId);
            } else {
                String insertSql = "INSERT INTO editors_db (title, summary, author, category, " +
                        "date_time, section_zone, intra_section_zone, lead_image_url, lead_image_caption, " +
                        "content_blocks, view_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

                KeyHolder keyHolder = new GeneratedKeyHolder();
                jdbcTemplate.update(connection -> {
                    PreparedStatement ps = connection.prepareStatement(insertSql, Statement.RETURN_GENERATED_KEYS);
                    ps.setString(1, article.getTitle());
                    ps.setString(2, article.getSummary());
                    ps.setString(3, article.getAuthor());
                    ps.setString(4, article.getCategory());
                    ps.setTimestamp(5, parseDateTimeLocal(article.getDate_time()));
                    ps.setString(6, article.getSection_zone());
                    if (article.getIntra_section_zone() != null) {
                        ps.setInt(7, article.getIntra_section_zone());
                    } else {
                        ps.setNull(7, java.sql.Types.TINYINT);
                    }
                    ps.setString(8, article.getLead_image_url());
                    ps.setString(9, article.getLead_image_caption());
                    ps.setString(10, blocksJson);
                    ps.setInt(11, viewCount);
                    return ps;
                }, keyHolder);

                articleId = keyHolder.getKey().longValue();
            }

            eventPublisher.publish(articleId, isUpdate ? "update" : "insert");

            return ResponseEntity.ok().body(Map.of("message", "Article saved successfully", "id", articleId));

        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    /*
    * handling paste.
    * */
    @PostMapping("/api/ingest/image-from-url")
    public ResponseEntity<?> handleImageFromUrl(@RequestBody Map<String, String> body) {
        String src = body == null ? null : body.get("url");
        if (src == null || src.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No url provided"));
        }

        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                    .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
                    .build();

            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(src))
                    .GET()
                    .build();

            java.net.http.HttpResponse<InputStream> res = client.send(
                    req, java.net.http.HttpResponse.BodyHandlers.ofInputStream());

            if (res.statusCode() != 200) {
                return ResponseEntity.badRequest().body(
                        Map.of("error", "Source returned " + res.statusCode()));
            }

            String contentType = res.headers().firstValue("content-type").orElse("");
            if (!contentType.startsWith("image/")) {
                return ResponseEntity.badRequest().body(
                        Map.of("error", "Not an image: " + contentType));
            }

            String ext = contentType.substring("image/".length()).split(";")[0].trim();
            if (ext.isEmpty()) ext = "jpg";
            String fileName = "pasted-" + System.currentTimeMillis() + "." + ext;

            String subDir = currentSubDir();
            Path finalPath = Paths.get(WEB_ROOT, subDir, fileName);
            Files.createDirectories(finalPath.getParent());

            try (InputStream in = res.body()) {
                Files.copy(in, finalPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }

            return ResponseEntity.ok(Map.of("path", subDir + "/" + fileName));

        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }
}


class ArticleRequest {
    private Long id;
    private String title;
    private String summary;
    private String author;
    private String category;
    private String date_time;
    private String section_zone;
    private Integer intra_section_zone;
    private String lead_image_url;
    private String lead_image_caption;

    private List<ContentBlock> content_blocks;
    private Integer view_count;

    // Getters and Setters
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }
    public String getAuthor() { return author; }
    public void setAuthor(String author) { this.author = author; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getDate_time() { return date_time; }
    public void setDate_time(String date_time) { this.date_time = date_time; }
    public String getSection_zone() { return section_zone; }
    public void setSection_zone(String section_zone) { this.section_zone = section_zone; }
    public Integer getIntra_section_zone() { return intra_section_zone; }
    public void setIntra_section_zone(Integer intra_section_zone) { this.intra_section_zone = intra_section_zone; }
    public String getLead_image_url() { return lead_image_url; }
    public void setLead_image_url(String lead_image_url) { this.lead_image_url = lead_image_url; }
    public String getLead_image_caption() { return lead_image_caption; }
    public void setLead_image_caption(String lead_image_caption) { this.lead_image_caption = lead_image_caption; }
    /*block data getters and setters*/
    public List<ContentBlock> getContent_blocks() { return content_blocks; }
    public void setContent_blocks(List<ContentBlock> blocks) { this.content_blocks = blocks; }
    // Add Getter and Setter for ID
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Integer getView_count() { return view_count; }
    public void setView_count(Integer view_count) { this.view_count = view_count; }
}

/**
 * One shape for every block type — mirrors the frontend's BlockDTO exactly.
 * content_json is ProseMirror JSON (paragraph blocks only); media_url/
 * caption/align are image/video blocks only. Jackson leaves whichever
 * fields don't apply as null on both sides, same as the frontend does.
 */
class ContentBlock {
    private String type; // 'paragraph', 'image', 'video'
    private Integer order_id;
    // Map, not JsonNode: ProseMirror JSON is an arbitrary nested tree, and a
    // Map<String,Object> represents it fully without binding this DTO to a
    // specific Jackson version's node classes. Spring Boot 4's HTTP layer
    // (Jackson 3) and the local mapper (Jackson 2) can both handle it.
    private Map<String, Object> content_json;
    private String media_url;
    private String caption;
    private String align; // 'left' | 'center' | 'right' — image/video only

    // Getters and Setters
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public Integer getOrder_id() { return order_id; }
    public void setOrder_id(Integer id) { this.order_id = id; }
    public Map<String, Object> getContent_json() { return content_json; }
    public void setContent_json(Map<String, Object> content_json) { this.content_json = content_json; }
    public String getMedia_url() { return media_url; }
    public void setMedia_url(String u) { this.media_url = u; }
    public String getCaption() { return caption; }
    public void setCaption(String caption) { this.caption = caption; }
    public String getAlign() { return align; }
    public void setAlign(String align) { this.align = align; }
}

/**
 * DTO matching the TypeScript interface:
 * interface EditorialItem { id: number; title: string; date_time: string; }
 */
class EditorialItemDTO {
    private Long id;
    private String title;
    private String date_time;

    // Getters and Setters
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getDate_time() { return date_time; }
    public void setDate_time(String date_time) { this.date_time = date_time; }
}

@Configuration
class SecurityConfig {

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public InMemoryUserDetailsManager userDetailsService(
            @Value("${pstv_m_usr}")  String mUsr,  @Value("${pstv_m_pswd}")  String mPswd,
            @Value("${pstv_e1_usr}") String e1Usr, @Value("${pstv_e1_pswd}") String e1Pswd,
            @Value("${pstv_e2_usr}") String e2Usr, @Value("${pstv_e2_pswd}") String e2Pswd,
            @Value("${pstv_e3_usr}") String e3Usr, @Value("${pstv_e3_pswd}") String e3Pswd) {

        PasswordEncoder enc = passwordEncoder();

        UserDetails manager = User.builder()
                .username(mUsr).password(enc.encode(mPswd)).roles("EDITOR").build();
        UserDetails e1 = User.builder()
                .username(e1Usr).password(enc.encode(e1Pswd)).roles("EDITOR").build();
        UserDetails e2 = User.builder()
                .username(e2Usr).password(enc.encode(e2Pswd)).roles("EDITOR").build();
        UserDetails e3 = User.builder()
                .username(e3Usr).password(enc.encode(e3Pswd)).roles("EDITOR").build();

        return new InMemoryUserDetailsManager(manager, e1, e2, e3);
    }
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                // 1. Allow CORS pre-flight requests
                .cors(withDefaults())
                // 2. Disable CSRF for your ingest APIs (or configure for tokens)
                .csrf(csrf -> csrf.disable())
                .authorizeHttpRequests(auth -> auth
                        // 3. Allow anyone to see the login/static assets if needed
                        .requestMatchers("/index.html", "/favicon.ico", "/*.js", "/*.css").permitAll()
                        // 4. Everything else requires authentication
                        .anyRequest().authenticated()
                )
                // 5. Use the default form login
                .formLogin(withDefaults());
        return http.build();
    }
}

@Configuration
class RabbitConfig {

    @Bean
    public EditorsDbEventPublisher editorsDbEventPublisher(
            @Value("${rabbit.host:localhost}") String host,
            @Value("${rabbit_mq_port}") int port,
            @Value("${rabbit_user}") String user,
            @Value("${rabbit_pswd}") String pass) {

        return new EditorsDbEventPublisher(host, port, user, pass);
    }
}

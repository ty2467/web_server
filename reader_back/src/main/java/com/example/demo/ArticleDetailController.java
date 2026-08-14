package com.example.demo;

import com.fasterxml.jackson.annotation.JsonRawValue;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.sql.Timestamp;
import java.time.ZoneId;
import java.util.List;

/**
 * Serves article.model.ts's Article shape straight from article_display —
 * the read model kept in sync from editors_db by the standalone RabbitMQ
 * consumer (consumer_editorsdb), not by anything in this project.
 *
 * Replaces the old /api/articles/{id} path (ArticleDTO/ArticlePageDTO/
 * queryArticleDTOs, reading article_paragraphs + article_media). Those
 * child tables and that DTO chain are gone from this endpoint — everything
 * an article needs is one row plus one JSON column now.
 */
@RestController
@RequestMapping("/api")
class ArticleDetailController {

    private final JdbcTemplate jdbcTemplate;

    // ASSUMPTION: DATETIME columns in article_display carry no timezone —
    // they're whatever the editor's browser sent via <input datetime-local>
    // (see writer_back's parseDateTimeLocal). Configure the zone they were
    // actually entered in via app.editorial-zone; defaulting to system
    // zone is very likely wrong the moment this deploys anywhere but the
    // editor's own machine.
    @Value("${app.editorial-zone:" + "#{T(java.time.ZoneId).systemDefault().getId()}" + "}")
    private String editorialZoneId;

    @Value("${app.base-url:http://192.168.123.72}")
    private String baseUrl;

    ArticleDetailController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/articles/{slug}")
    public ResponseEntity<ArticleDetailDTO> getArticle(@PathVariable String slug) {
        System.out.println("any activation");
        List<ArticleDetailDTO> rows = jdbcTemplate.query(
                "SELECT * FROM article_display WHERE slug = ? AND state = 'published'",
                (rs, rowNum) -> {
                    ArticleDetailDTO dto = new ArticleDetailDTO();
                    dto.schema = rs.getInt("schema_version");
                    dto.id = rs.getLong("id");
                    dto.slug = rs.getString("slug");
                    dto.canonicalUrl = baseUrl + "/article/" + dto.slug;
                    dto.headline = rs.getString("headline");
                    dto.dek = rs.getString("dek");
                    dto.category = rs.getString("category");
                    dto.author = rs.getString("author_name");
                    dto.publishedAt = toIso(rs.getTimestamp("published_at"));
                    dto.updatedAt = toIso(rs.getTimestamp("revised_at")); // null-safe, stays null if never revised
                    dto.state = rs.getString("state");
                    dto.readingTimeMinutes = rs.getInt("reading_time_minutes");
                    dto.blocks = rs.getString("content_blocks"); // already display-shape JSON, embedded raw
                    dto.viewCount = rs.getInt("view_count");
                    System.out.println("basic construction terminal point reached");
                    String leadUrl = rs.getString("lead_image_url");
                    if (leadUrl != null) {
                        LeadImageDTO lead = new LeadImageDTO();
                        lead.url = leadUrl;
                        lead.alt = rs.getString("lead_image_alt");
                        lead.caption = rs.getString("lead_image_caption");
                        lead.credit = rs.getString("lead_image_credit");
                        dto.leadImage = lead;

                    }
                    System.out.println("dto return reached");
                    System.out.println(dto);
                    return dto;
                }, slug
        );

        return rows.isEmpty() ? ResponseEntity.notFound().build() : ResponseEntity.ok(rows.get(0));
    }

    /** Matches Pick<Article, 'slug' | 'headline'> on the frontend — nothing more. */
    @GetMapping("/articles/{slug}/suggested")
    public List<SuggestedArticleDTO> getSuggested(@PathVariable String slug) {
        return jdbcTemplate.query(
                """
                SELECT * FROM (
                    SELECT slug, headline FROM article_display
                    WHERE slug != ? AND state = 'published'
                    ORDER BY published_at DESC
                    LIMIT 50
                ) AS recent_pool
                ORDER BY RAND()
                LIMIT 4
                """,
                (rs, rowNum) -> {
                    SuggestedArticleDTO s = new SuggestedArticleDTO();
                    s.slug = rs.getString("slug");
                    s.headline = rs.getString("headline");
                    return s;
                }, slug
        );
    }

    private String toIso(Timestamp ts) {
        if (ts == null) return null;
        return ts.toLocalDateTime()
                .atZone(ZoneId.of(editorialZoneId))
                .toOffsetDateTime()
                .toString();
    }
}

/** Field-for-field match with Article in article.model.ts. */
class ArticleDetailDTO {
    public int schema;
    public long id;
    public String slug;
    public String canonicalUrl;
    public String headline;
    public String dek;
    public String category;
    public String author;
    public String publishedAt;
    public String updatedAt;
    public LeadImageDTO leadImage;
    @JsonRawValue
    public String blocks; // raw content_blocks JSON, embedded as-is — not re-parsed
    public String state;


    public int readingTimeMinutes;
    public int viewCount;

}

class LeadImageDTO {
    public String url;
    public String alt;
    public String caption;
    public String credit;
}

class SuggestedArticleDTO {
    public String slug;
    public String headline;
}
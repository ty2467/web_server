package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@SpringBootApplication
public class SpringBootTutorialApplication {
    public static void main(String[] args) {
        SpringApplication.run(SpringBootTutorialApplication.class, args);
    }
}

class MediaDTO {
    public String url;
    public String type;
    public int orderId;

    public MediaDTO(String url, String type, int orderId) {
        this.url = url;
        this.type = type;
        this.orderId = orderId;
    }

    public MediaDTO(String url, String type) {
        this.url = url;
        this.type = type;
        this.orderId = 0;
    }
}

class ParagraphDTO {
    public String text;
    public int orderId;

    public ParagraphDTO(String text, int orderId) {
        this.text = text;
        this.orderId = orderId;
    }
}

class Article {
    public String id;
    public String slug;
    public String title;
    public String summary;
    public String image;
    public String video;
    public String category;

    /**
     * home_page.section_zone is a MariaDB SET('main','sub_main','tertiary','column').
     * It travels as the comma-joined string the driver returns — 'main',
     * 'sub_main,column', 'column' — always in SET-DEFINITION order regardless
     * of write order. Deliberately NOT split into a List here: the frontend
     * does membership tests on it, and a String survives the JSON boundary
     * without either side agreeing on an ordering.
     */
    public String section_zone;

    /** 排列 within the chosen front: 0 = 中心, 1 = 侧, 2 = 底. Null for 栏目-only rows. */
    public Integer intra_section_zone;

    public Article() {}

    public Article(String title, String summary, String category, String asset, boolean isVideo) {
        this.title = title;
        this.summary = summary;
        this.category = category;
        if (isVideo) {
            this.video = asset;
        } else {
            this.image = asset;
        }
    }

    public Article(String id, String title, String summary, String category, String image) {
        this.id = id;
        this.title = title;
        this.summary = summary;
        this.category = category;
        this.image = image;
    }
}

class PageDataDTO {
    public List<String> menuItems;
    public String bannerText;
    public List<Article> articlePool;
}


@RestController
@RequestMapping("/api")
class NewsController {

    private final JdbcTemplate jdbcTemplate;

    public NewsController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * SET MEMBERSHIP, NOT EQUALITY.
     *
     * section_zone can hold two members at once ('sub_main,column'), so
     * `section_zone = 'sub_main'` silently misses every article that is
     * also in 栏目. FIND_IN_SET is the only correct test. There is no index
     * to lose by using it — the column was never indexed and the table is
     * scanned regardless.
     */
    private static final String ON_ANY_FRONT =
            "(FIND_IN_SET('main', section_zone) " +
                    " OR FIND_IN_SET('sub_main', section_zone) " +
                    " OR FIND_IN_SET('tertiary', section_zone))";

    private static final String SELECT_COLS =
            "SELECT id, slug, title, dek, category, section_zone, intra_section_zone, cover_media_url ";

    @GetMapping("/home-page")
    public PageDataDTO getHomePageData() {
        PageDataDTO data = new PageDataDTO();

        data.menuItems = jdbcTemplate.queryForList(
                "SELECT DISTINCT category FROM home_page WHERE category IS NOT NULL LIMIT 7", String.class);
        data.bannerText = "Latest Updates from the Newsroom";

        // ORDER NO LONGER CARRIES MEANING.
        //
        // The old query encoded a linear-ingestion contract: zone order via
        // FIELD(), 中心 before 侧/底, rows of a unit kept contiguous, because
        // the frontend attached each side to whichever unit it had pushed
        // last. That frontend is gone — the ingester now reads section_zone
        // and intra_section_zone off each row and drops it in the matching
        // bucket, so any permutation of this result set produces the same
        // page.
        //
        // The one thing order still does is decide who survives LIMIT 100,
        // so fronts sort ahead of 栏目-only rows: a 主板 article from last
        // month must not fall off the bottom behind a hundred fresh 栏目
        // pieces. Within each group, newest first.
        //
        // Rows with no placement at all are excluded rather than shipped and
        // dropped client-side. '' is a legal (empty) SET value, hence both
        // tests.
        String sql = SELECT_COLS +
                "FROM home_page " +
                "WHERE section_zone IS NOT NULL AND section_zone <> '' " +
                "ORDER BY " +
                "  CASE WHEN " + ON_ANY_FRONT + " THEN 0 ELSE 1 END, " +
                "  date_time DESC " +
                "LIMIT 100";

        data.articlePool = queryArticles(sql);

        return data;
    }

    @GetMapping("/category/{name}")
    public PageDataDTO getCategoryPageData(@PathVariable String name) {
        PageDataDTO data = new PageDataDTO();

        data.menuItems = jdbcTemplate.queryForList(
                "SELECT DISTINCT category FROM home_page WHERE category IS NOT NULL LIMIT 7", String.class);
        data.bannerText = "Latest in " + name;

        // The category page shows ONE front block over an unbounded feed, so
        // unlike the homepage it doesn't care which front an article is on —
        // only whether it's on one, and what its 排列 is. Front-placed rows
        // sort first so the block can be filled from the head of the list;
        // everything else follows as feed material, newest first.
        //
        // Unplaced rows are NOT excluded here: a category page is a category
        // archive, and an article with no homepage placement still belongs in
        // its own category's feed.
        String sql = SELECT_COLS +
                "FROM home_page " +
                "WHERE category = ? " +
                "ORDER BY " +
                "  CASE WHEN " + ON_ANY_FRONT + " THEN 0 ELSE 1 END, " +
                "  intra_section_zone IS NULL, " +
                "  intra_section_zone ASC, " +
                "  date_time DESC " +
                "LIMIT 100";

        data.articlePool = queryArticles(sql, name);

        return data;
    }

    private List<Article> queryArticles(String sql, Object... args) {
        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            Article a = new Article();
            a.id = String.valueOf(rs.getLong("id"));
            a.slug = rs.getString("slug");
            a.title = rs.getString("title");
            a.summary = rs.getString("dek");        // home_page.dek -> Article.summary
            a.category = rs.getString("category");

            // getString on a SET column returns the comma form; no parsing here.
            a.section_zone = rs.getString("section_zone");

            a.intra_section_zone = rs.getObject("intra_section_zone") != null
                    ? rs.getInt("intra_section_zone")
                    : null;

            // One cover column, image only. No child-table lookup.
            a.image = rs.getString("cover_media_url");

            return a;
        }, args);
    }
}
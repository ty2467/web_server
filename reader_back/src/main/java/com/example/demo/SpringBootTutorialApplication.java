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


    private static final String CATEGORY_RANK =
            "FIELD(category, '美洲头条', '工商新闻', 'CES 国际消费电子展', '天天话题')";


    private static final String FRONT_OF =
            "CASE WHEN FIND_IN_SET('main', section_zone) THEN 'main' " +
                    "     WHEN FIND_IN_SET('sub_main', section_zone) THEN 'sub_main' " +
                    "     WHEN FIND_IN_SET('tertiary', section_zone) THEN 'tertiary' END";

    @GetMapping("/home-page")
    public PageDataDTO getHomePageData() {
        PageDataDTO data = new PageDataDTO();

        data.menuItems = jdbcTemplate.queryForList(
                "SELECT DISTINCT category FROM home_page WHERE category IS NOT NULL LIMIT 7", String.class);
        data.bannerText = "Latest Updates from the Newsroom";

        // 侧 AND 底 ARE CAPPED PER FRONT, PER SLOT.
//
// rn_slot ranks within (front, 排列), so 主板's sides and 次板's sides are
// separate races and neither crowds the other. Three each: the 底 grid is
// three columns wide and the side rail holds three before it outruns the
// lead image beside it.
//
// 中心 is deliberately uncapped — on 主板 it is the rotisserie, whose
// plurality is the feature, and on the other two a second 中心 is an
// editorial mistake the frontend already warns about. Capping it would
// hide that.
//
// A row on a front AND in 栏目 can pass on its 栏目 rank alone, so an
// over-cap side still reaches the page and the frontend still places it in
// both. Rare, and dropping a 栏目 article to enforce a front cap is worse.
        String sql =
                "SELECT id, slug, title, dek, category, section_zone, intra_section_zone, cover_media_url " +
                        "FROM ( " +
                        "  SELECT h.*, " +
                        "         " + FRONT_OF + " AS front, " +
                        "         (FIND_IN_SET('column', section_zone) > 0) AS is_column, " +
                        "         ROW_NUMBER() OVER ( " +
                        "           PARTITION BY " + FRONT_OF + ", intra_section_zone " +
                        "           ORDER BY date_time DESC) AS rn_slot, " +
                        "         ROW_NUMBER() OVER ( " +
                        "           PARTITION BY category, (FIND_IN_SET('column', section_zone) > 0) " +
                        "           ORDER BY date_time DESC) AS rn_col " +
                        "  FROM home_page h " +
                        "  WHERE section_zone IS NOT NULL AND section_zone <> '' " +
                        ") ranked " +
                        "WHERE (front IS NOT NULL AND (intra_section_zone = 0 OR rn_slot <= 3)) " +
                        "   OR (is_column AND rn_col <= 4) " +
                        "ORDER BY " + CATEGORY_RANK + " = 0, " + CATEGORY_RANK + ", date_time DESC";
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
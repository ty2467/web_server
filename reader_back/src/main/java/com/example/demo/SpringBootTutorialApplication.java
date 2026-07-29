package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
//import org.springframework.web.bind.annotation.GetMapping;
//import org.springframework.web.bind.annotation.RequestMapping;
//import org.springframework.web.bind.annotation.RestController;
//import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.*;

import java.util.Arrays;
import java.util.List;

import java.util.*;
import java.util.stream.Collectors;

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

    // New constructor for intermixed content
    public MediaDTO(String url, String type, int orderId) {
        this.url = url;
        this.type = type;
        this.orderId = orderId;
    }

    // Restore 2-arg constructor for Homepage/Thumbnails (Fixes line 322/325 error...please dont type enter before i update reference... from line)
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

    // Replacing legacy is_featured with your new schema columns
    public String section_zone;
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

    // Flattened from Map to List for linear frontend ingestion
    public List<Article> articlePool;
}




@RestController
@RequestMapping("/api")
class NewsController {

    private final JdbcTemplate jdbcTemplate;

    public NewsController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }



    //    Read5
    @GetMapping("/home-page")
    public PageDataDTO getHomePageData() {
        PageDataDTO data = new PageDataDTO();

        // Keep the IS NOT NULL here only so the frontend menu doesn't render a blank tab
        data.menuItems = jdbcTemplate.queryForList(
                "SELECT DISTINCT category FROM home_page WHERE category IS NOT NULL LIMIT 7", String.class);
        data.bannerText = "Latest Updates from the Newsroom";

        // LINEAR INGESTION. The ingester attaches sides/sections to
        // layout[last], so within each unit zone 1 must arrive before 2/3,
        // and rows of one unit must stay contiguous.
        //
        // NULL handling is done with `IS NULL` sort keys instead of
        // COALESCE: no sentinel values, and intra_section_zone keeps its
        // real numeric ordering rather than being compared against 99.
        //
        // slug added to the select list — this is what routerLinks on the
        // frontend now navigate with, instead of the raw home_page/
        // editors_db id. See Article.slug and queryArticles() below.
        String sql = "SELECT id, slug, title, dek, category, section_zone, intra_section_zone, cover_media_url " +
                "FROM home_page " +
                "ORDER BY " +
                "  section_zone IS NULL, " +
                "  FIELD(section_zone, 'rotisserie', 'major_front', 'half_front', 'matrix'), " +
                "  category, " +
                "  intra_section_zone IS NULL, " +
                "  intra_section_zone ASC, " +
                "  date_time DESC " +
                "LIMIT 100";

        data.articlePool = queryArticles(sql);

        System.out.println("finished");

        return data;
    }
//read5
//    @GetMapping("/category/{name}")
//    public PageDataDTO getCategoryPageData(@PathVariable String name) {
//        PageDataDTO data = new PageDataDTO();
//
//        // 1. Maintain consistent Navigation
//        data.menuItems = jdbcTemplate.queryForList(
//                "SELECT DISTINCT category FROM news_articles WHERE category IS NOT NULL LIMIT 7",
//                String.class
//        );
//
//        data.bannerText = "Explore: " + name;
//
//        // 2. Fetch the pool for this specific category
//        // We fetch a larger set (e.g., 50) so the frontend has enough to fill the layout
//        String categorySql = "SELECT * FROM news_articles WHERE category = ? ORDER BY date_time DESC LIMIT 50";
//        List<Article> categoryArticles = queryArticles(categorySql, name);
//
//        // 3. Apply the "Home Page Formula"
//        // We put the results into the categorizedPool map using the category name as the key.
//        // The frontend can now iterate through this map just like it does on the home page.
//        data.categorizedPool = new LinkedHashMap<>();
//        data.categorizedPool.put(name, categoryArticles);
//
//        return data;
//    }



    //  Read5
    private List<Article> queryArticles(String sql, Object... args) {
        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            Article a = new Article();
            String articleId = String.valueOf(rs.getLong("id"));
            a.id = articleId;
            a.slug = rs.getString("slug");
            a.title = rs.getString("title");
            a.summary = rs.getString("dek");        // home_page.dek -> Article.summary
            a.category = rs.getString("category");

            // Map the new layout routing columns
            a.section_zone = rs.getString("section_zone");
            a.intra_section_zone = rs.getObject("intra_section_zone") != null
                    ? rs.getInt("intra_section_zone")
                    : null;

            // One cover column, image only. No child-table lookup.
            a.image = rs.getString("cover_media_url");

            return a;
        }, args);
    }

    /**
     * Helper to safely slice lists to avoid IndexOutOfBoundsException
     */
    private List<Article> getSafeSubList(List<Article> list, int start, int end) {
        if (list.size() < start) return new ArrayList<>();
        return list.subList(start, Math.min(end, list.size()));
    }


}
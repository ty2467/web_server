package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
class SearchControllerTest {

    @Autowired SearchController controller;
    @Autowired JdbcTemplate jdbc;

    private double cosineDistance(String a, String b) {
        return jdbc.queryForObject(
                "SELECT VEC_DISTANCE_COSINE(VEC_FromText(?), VEC_FromText(?))",
                Double.class, a, b);
    }

    @Test
    void embedding_hasExpectedShape() {
        List<Float> v = controller.embedQuery("美國大選");

        assertEquals(SearchController.DIM, v.size());
        assertTrue(v.stream().allMatch(f -> Float.isFinite(f)), "non-finite component");
        assertFalse(v.stream().allMatch(f -> f == 1.0f), "came back as the placeholder vector");
        assertFalse(v.stream().allMatch(f -> f == 0.0f), "came back all zeros");
    }

    @Test
    void vecText_isAcceptedByMariaDB() {
        String vec = SearchController.toVecText(controller.embedQuery("美國大選"));

        // round-trips through VEC_FromText; self-distance ~0
        assertEquals(0.0, cosineDistance(vec, vec), 1e-6);
    }

    @Test
    void embedding_isSemanticallyOrdered() {
        String anchor    = SearchController.toVecText(controller.embedQuery("美國總統大選"));
        String related   = SearchController.toVecText(controller.embedQuery("美國選舉投票結果"));
        String unrelated = SearchController.toVecText(controller.embedQuery("紅燒肉的做法"));

        double near = cosineDistance(anchor, related);
        double far  = cosineDistance(anchor, unrelated);
        assertTrue(near < far, "related=" + near + " unrelated=" + far);
    }

    @Test
    void embedding_isStableAcrossCalls() {
        String a = SearchController.toVecText(controller.embedQuery("中美關係"));
        String b = SearchController.toVecText(controller.embedQuery("中美關係"));

        assertEquals(0.0, cosineDistance(a, b), 1e-3);
    }

    @Test
    void search_returnsCappedRowsWithReaderShape() {
        List<Map<String, Object>> rows = controller.search("美國大選", 10);

        assertTrue(rows.size() <= 10);
        for (Map<String, Object> r : rows) {
            assertTrue(r.keySet().containsAll(
                            List.of("id", "slug", "title", "summary", "image", "category", "date_time")),
                    "missing columns: " + r.keySet());
        }
    }

    @Test
    void search_blankQuery_skipsEmbedding() {
        assertTrue(controller.search("   ", 10).isEmpty());
    }
}
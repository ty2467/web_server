import com.google.genai.Client;
import com.google.genai.types.EmbedContentConfig;
import com.google.genai.types.EmbedContentResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api")
public class SearchController {

    private static final String MODEL = "gemini-embedding-001";
    private static final int DIM = 768;
    private static final int MAX_LIMIT = 50;

    private final JdbcTemplate jdbc;
    private final Client gemini;

    public SearchController(JdbcTemplate jdbc, @Value("${gemini.api-key}") String apiKey) {
        this.jdbc = jdbc;
        this.gemini = Client.builder().apiKey(apiKey).build();
    }

    @GetMapping("/search")
    public List<Map<String, Object>> search(@RequestParam String q,
                                            @RequestParam(defaultValue = "50") int limit) {
        String query = q.strip();
        if (query.isEmpty()) return List.of();
        if (query.length() > 200) query = query.substring(0, 200);
        int n = Math.max(1, Math.min(limit, MAX_LIMIT));

        EmbedContentResponse res = gemini.models.embedContent(
                MODEL, query,
                EmbedContentConfig.builder().outputDimensionality(DIM).build());
        List<Float> v = res.embeddings().orElseThrow().get(0).values().orElseThrow();
        String vec = v.stream().map(String::valueOf).collect(Collectors.joining(",", "[", "]"));

        // date filter first, then cosine over that set; placeholder rows (all 1.0f) excluded
        return jdbc.queryForList("""
                SELECT id, slug, title, dek AS summary, cover_media_url AS image, category,
                       section_zone, intra_section_zone, category_position, date_time
                FROM home_page
                WHERE date_time >= NOW() - INTERVAL 1 YEAR
                  AND embedding <> REPEAT(X'0000803f', 768)
                ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText(?))
                LIMIT ?
                """, vec, n);
    }
}
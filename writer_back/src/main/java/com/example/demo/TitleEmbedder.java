package org.example.springboottutorial;

import com.google.genai.Client;
import com.google.genai.types.EmbedContentConfig;
import com.google.genai.types.EmbedContentResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Component
class TitleEmbedder {

    private static final int DIM = 768;

    private final JdbcTemplate jdbcTemplate;
    private final Client client;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "title-embedder");
        t.setDaemon(true);
        return t;
    });

    TitleEmbedder(JdbcTemplate jdbcTemplate, @Value("${GEMINI_API_KEY}") String apiKey) {
        this.jdbcTemplate = jdbcTemplate;
        this.client = Client.builder().apiKey(apiKey.strip()).build();
    }

    /**
     * One Gemini call: text -> 768 little-endian float32 = 3072 bytes,
     * the VECTOR(768) wire format. taskType is "RETRIEVAL_DOCUMENT" for
     * stored titles, "RETRIEVAL_QUERY" for search input.
     */
    byte[] embed(String text, String taskType) {
        EmbedContentResponse res = client.models.embedContent(
                "gemini-embedding-001", text,
                EmbedContentConfig.builder()
                        .taskType(taskType)
                        .outputDimensionality(DIM)
                        .build());
        List<Float> values = res.embeddings().get().get(0).values().get();

        ByteBuffer buf = ByteBuffer.allocate(DIM * Float.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (Float f : values) buf.putFloat(f);
        return buf.array();
    }

    void embedAsync(Long id, String title) {
        if (title == null || title.isBlank()) return;
        executor.submit(() -> {
            try {
                byte[] vec = embed(title, "RETRIEVAL_DOCUMENT");
                jdbcTemplate.update("UPDATE editors_db SET embedding = ? WHERE id = ?", vec, id);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }
}
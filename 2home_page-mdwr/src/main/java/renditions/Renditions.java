package renditions;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * For an original at /srv/media/ifengus/<dir>/<name>.<ext>, produces
 * <name>_big.webp and <name>_small.webp in the same <dir>, served by nginx
 * at /media/<dir>/<name>_big.webp and /media/<dir>/<name>_small.webp.
 *
 * Shared by the one-off backfill and, later, the ingest-time listener.
 * Idempotent: a tier is skipped when its file exists and is not older than
 * the source, so re-runs only redo what changed.
 */
public final class Renditions {

    static final Path MEDIA_ROOT = Path.of("/srv/media/ifengus");
    static final String URL_PREFIX = "/media/";

    enum Tier {
        BIG("big", 1200, 675),
        SMALL("small", 480, 270);

        final String suffix;
        final int w, h;

        Tier(String suffix, int w, int h) {
            this.suffix = suffix;
            this.w = w;
            this.h = h;
        }
    }

    enum Result { DONE, SKIPPED, NO_SOURCE, FAILED }

    private Renditions() {}

    /** Generates both tiers for one article. Returns the worst outcome. */
    public static Result render(long id, String mediaUrl) {
        Path src = sourceFor(mediaUrl);
        if (src == null || !Files.isRegularFile(src)) {
            System.err.printf("[renditions] id=%d: no local source for %s%n", id, mediaUrl);
            return Result.NO_SOURCE;
        }

        String name = src.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;

        boolean didWork = false;
        for (Tier tier : Tier.values()) {
            Path out = src.resolveSibling(stem + "_" + tier.suffix + ".webp");
            try {
                if (isFresh(out, src)) continue;
                renderTier(src, out, tier);
                didWork = true;
            } catch (IOException | InterruptedException e) {
                if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                System.err.printf("[renditions] id=%d %s: %s%n", id, tier.suffix, e.getMessage());
                return Result.FAILED;
            }
        }
        return didWork ? Result.DONE : Result.SKIPPED;
    }

    /**
     * Maps a stored URL (absolute "https://host/media/x.jpg" or relative
     * "/media/x.jpg") onto the file nginx's alias points at. Anything outside
     * /media/, or escaping MEDIA_ROOT via "..", has no local source.
     */
    static Path sourceFor(String mediaUrl) {
        if (mediaUrl == null || mediaUrl.isBlank()) return null;
        String url = mediaUrl.trim();

        String path;
        try {
            path = URI.create(url).getPath(); // also percent-decodes
        } catch (IllegalArgumentException e) {
            // Raw spaces or other characters URI rejects: take the path by hand.
            int i = url.indexOf(URL_PREFIX);
            if (i < 0) return null;
            path = url.substring(i).split("[?#]", 2)[0];
        }
        if (path == null || !path.startsWith(URL_PREFIX)) return null;

        Path p = MEDIA_ROOT.resolve(path.substring(URL_PREFIX.length())).normalize();
        return p.startsWith(MEDIA_ROOT) ? p : null;
    }

    private static boolean isFresh(Path out, Path src) throws IOException {
        return Files.exists(out)
            && Files.getLastModifiedTime(out).compareTo(Files.getLastModifiedTime(src)) >= 0;
    }

    /**
     * Resizes and attention-crops to the exact tier box, then renames into
     * place so nginx never serves a half-written file.
     */
    private static void renderTier(Path src, Path out, Tier tier)
            throws IOException, InterruptedException {
        Path tmp = out.resolveSibling(out.getFileName() + ".tmp.webp");

        Process p = new ProcessBuilder(
                "vipsthumbnail", src.toString(),
                "--size", tier.w + "x" + tier.h,
                "--smartcrop", "attention",
                "-o", tmp + "[Q=75,keep=none]")
            .redirectErrorStream(true)
            .start();

        String log = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        int code = p.waitFor();
        if (code != 0 || !Files.isRegularFile(tmp)) {
            Files.deleteIfExists(tmp);
            throw new IOException("vipsthumbnail exit " + code + (log.isEmpty() ? "" : ": " + log));
        }

        Files.move(tmp, out, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
}

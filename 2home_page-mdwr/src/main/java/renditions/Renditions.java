package renditions;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * For an original at /srv/media/ifengus/<dir>/<name>.<ext>, produces
 * <name>_big.webp and <name>_small.webp in the same <dir>, served by nginx
 * at /media/<dir>/<name>_big.webp and /media/<dir>/<name>_small.webp.
 *
 * Shared by the one-off backfill and, later, the ingest-time listener.
 * Idempotent: a tier is skipped when its file exists and is not older than
 * the source, so re-runs only redo what changed.
 *
 * Every output is exactly the tier's 16:9 box: the source is shrunk to fit
 * inside it (never enlarged, never cropped) and padded out to the box.
 * A true 16:9 source fills it with no padding at all.
 */
public final class Renditions {

    static final Path MEDIA_ROOT = Path.of("/srv/media/ifengus");
    static final String URL_PREFIX = "/media/";

    private static final Pattern HEADER = Pattern.compile("(\\d+)x(\\d+) \\w+, (\\d+) bands?,");

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
     * Writes the tier's exact box to a temp file, then renames into place so
     * nginx never serves a half-written file.
     *
     * vipsthumbnail fits inside the box without enlarging ("WxH>"), then
     * vips gravity centres that on a WxH canvas — white, or transparent when
     * the image has alpha (WebP keeps it).
     */
    private static void renderTier(Path src, Path out, Tier tier)
            throws IOException, InterruptedException {
        Path tmp = out.resolveSibling(out.getFileName() + ".tmp.webp");
        Path fit = out.resolveSibling(out.getFileName() + ".fit.v");
        String box = tier.w + "x" + tier.h;

        try {
            exec(List.of("vipsthumbnail", src.toString(),
                    "--size", box + ">", "-o", fit.toString()));
            // Bands read from the fitted image, not the source:
            // vipsthumbnail may have converted it (e.g. CMYK -> sRGB).
            int bands = probe(fit)[2];
            exec(List.of("vips", "gravity", fit.toString(), tmp + "[Q=75,keep=none]", "centre",
                    String.valueOf(tier.w), String.valueOf(tier.h),
                    "--extend", "background", "--background", padColour(bands)));

            if (!Files.isRegularFile(tmp)) throw new IOException("no output written");
            Files.move(tmp, out, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException | InterruptedException e) {
            Files.deleteIfExists(tmp);
            throw e;
        } finally {
            Files.deleteIfExists(fit);
        }
    }

    /** {width, height, bands} from vipsheader's one-line summary. */
    private static int[] probe(Path file) throws IOException, InterruptedException {
        String line = exec(List.of("vipsheader", file.toString()));
        Matcher m = HEADER.matcher(line);
        if (!m.find()) throw new IOException("unreadable header: " + line);
        return new int[] {
                Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))
        };
    }

    /** White for opaque images; white at zero alpha where there is an alpha band. */
    private static String padColour(int bands) {
        return switch (bands) {
            case 1 -> "255";
            case 2 -> "255 0";
            case 3 -> "255 255 255";
            default -> "255 255 255 0";
        };
    }

    private static String exec(List<String> cmd) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String log = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        int code = p.waitFor();
        if (code != 0) {
            throw new IOException(cmd.get(0) + " exit " + code + (log.isEmpty() ? "" : ": " + log));
        }
        return log;
    }
}
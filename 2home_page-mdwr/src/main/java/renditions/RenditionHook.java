package renditions;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ingest-time entry point for Renditions, called by HomePageSync after its
 * home_page upsert commits. Runs on its own single thread so a slow vips
 * call never delays the Rabbit ack, and one thread keeps the spinning disk
 * from seeking between parallel jobs.
 *
 * Fire-and-forget: a failure is logged by Renditions and does not affect the
 * home_page sync. Anything lost (a crash with work still queued) is picked up
 * by re-running RenditionBackfill, which skips everything already done.
 */
public final class RenditionHook {

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "renditions");
        t.setDaemon(true);
        return t;
    });

    private RenditionHook() {}

    public static void enqueue(long homePageId, String coverMediaUrl) {
        if (coverMediaUrl == null || coverMediaUrl.isBlank()) return;
        EXEC.submit(() -> Renditions.render(homePageId, coverMediaUrl));
    }
}

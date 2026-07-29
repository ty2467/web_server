package org.example.springboottutorial;

import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.MessageProperties;

import java.nio.charset.StandardCharsets;
import java.time.Instant;

/**
 * Fire-and-forget notifier: "editors_db row N changed". Nothing downstream
 * depends on this arriving — editors_db is still the sole source of truth.
 * If RabbitMQ is unreachable, publish() logs and returns; it must never
 * throw back into ingest() and turn a successful DB write into a failed
 * save from the editor's point of view.
 *
 * One long-lived connection/channel for the app's lifetime — not opened
 * per publish. Not thread-safe for concurrent publishes from multiple
 * threads without synchronizing basicPublish; fine for this app's traffic,
 * revisit with a channel pool only if ingest() ever needs real concurrency.
 */
public class EditorsDbEventPublisher {

    private static final String EXCHANGE = "editors_db.events";

    private final Connection connection;
    private final Channel channel;

    public EditorsDbEventPublisher(String host, int port, String user, String pass) {
        Connection conn = null;
        Channel ch = null;
        try {
            System.out.println("activated");
            ConnectionFactory factory = new ConnectionFactory();
            factory.setHost(host);
            factory.setPort(port);
            factory.setUsername(user);
            factory.setPassword(pass);
            conn = factory.newConnection("writer_back-publisher");
            ch = conn.createChannel();
            // topic, not fanout: costs nothing now, lets a future consumer
            // subscribe to a narrower routing key than "everything" later.
            ch.exchangeDeclare(EXCHANGE, "topic", /* durable */ true);
        } catch (Exception e) {
            System.err.println("[rabbit] could not connect at startup: " + e.getMessage());
            // conn/ch stay null; publish() below no-ops safely from here on.
        }
        this.connection = conn;
        this.channel = ch;
    }

    /** op is "insert" or "update" — becomes the routing key suffix. */
    public void publish(long editorsDbId, String op) {
        System.out.println("publish hit");
        if (channel == null) return; // never connected; already logged at startup

        String routingKey = "editors_db." + op;
        String body = String.format(
                "{\"id\":%d,\"op\":\"%s\",\"ts\":\"%s\"}",
                editorsDbId, op, Instant.now()
        );

        try {
            channel.basicPublish(
                    EXCHANGE, routingKey,
                    MessageProperties.PERSISTENT_TEXT_PLAIN,
                    body.getBytes(StandardCharsets.UTF_8)
            );
        } catch (Exception e) {
            // Swallow deliberately — see class comment. A missed notification
            // just means article_display is stale until the next edit.
            System.err.println("[rabbit] publish failed for editors_db id=" +
                    editorsDbId + ": " + e.getMessage());
        }
    }
}
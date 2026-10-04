package io.github.edwardpratt.orrery;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Deque;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Line-delimited JSON connection to the hub. Runs on its own daemon threads and never touches Minecraft classes, so
 * the game thread only ever calls {@link #send} and {@link #poll}.
 */
public class HubClient {

    static final int MAX_OUTBOX = 1000;
    private static final Logger LOG = LogManager.getLogger("orrery");

    private final String host;
    private final int port;
    private final JsonObject hello = new JsonObject();
    private final LinkedBlockingDeque<JsonObject> outbox = new LinkedBlockingDeque<>();
    private final ConcurrentLinkedQueue<JsonObject> inbox = new ConcurrentLinkedQueue<>();
    private volatile boolean running;
    private volatile boolean connected;
    private volatile Socket socket;
    private Thread thread;
    long minBackoffMs = 1000;
    long maxBackoffMs = 30_000;

    public HubClient(String host, int port, String serverId, String token, String modVersion) {
        this.host = host;
        this.port = port;
        hello.addProperty("type", "hello");
        hello.addProperty("protocol", 1);
        hello.addProperty("serverId", serverId);
        hello.addProperty("token", token);
        hello.addProperty("modVersion", modVersion);
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::run, "Orrery-hub");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Queues a message for the hub. While disconnected only started/stopping are kept, so a hub outage never replays
     * stale chat. The queue is bounded: when full, the oldest message is dropped.
     */
    public void send(JsonObject msg) {
        if (!connected && !isLifecycle(msg)) return;
        synchronized (outbox) {
            if (outbox.size() >= MAX_OUTBOX) outbox.pollFirst();
            outbox.offerLast(msg);
        }
    }

    private static boolean isLifecycle(JsonObject msg) {
        String type = str(msg, "type");
        return type.equals("started") || type.equals("stopping");
    }

    /** After a connection ends, only started/stopping survive: other lines would be stale by the next connection. */
    static void dropNonLifecycle(Deque<JsonObject> queue) {
        synchronized (queue) {
            queue.removeIf(msg -> !isLifecycle(msg));
        }
    }

    /** Next message from the hub, or null. */
    public JsonObject poll() {
        return inbox.poll();
    }

    public boolean isConnected() {
        return connected;
    }

    /**
     * Writes out whatever is queued (waiting at most timeoutMs; 0 = don't wait), then disconnects for good. Safe to
     * call twice.
     */
    public void stop(long timeoutMs) {
        running = false;
        Thread t = thread;
        if (t == null) return;
        t.interrupt();
        try {
            if (timeoutMs > 0) t.join(timeoutMs); // join(0) would wait forever
        } catch (InterruptedException e) {
            Thread.currentThread()
                .interrupt();
        }
        closeQuietly(socket);
    }

    private void run() {
        long backoff = minBackoffMs;
        while (running) {
            try (Socket s = new Socket()) {
                socket = s;
                s.connect(new InetSocketAddress(host, port), 5000);
                Writer out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                writeLine(out, hello.toString());
                JsonObject reply = parse(in.readLine());
                if (reply != null && "welcome".equals(str(reply, "type"))) {
                    connected = true;
                    backoff = minBackoffMs;
                    LOG.info("Connected to hub at {}:{}", host, port);
                    Thread reader = new Thread(() -> readLoop(s, in), "Orrery-hub-reader");
                    reader.setDaemon(true);
                    reader.start();
                    writeLoop(s, out);
                } else {
                    LOG.error("Hub refused connection: {}", reply == null ? "no reply" : str(reply, "reason"));
                    backoff = maxBackoffMs;
                }
            } catch (IOException e) {
                if (running) LOG.warn("Hub connection failed: {}", e.getMessage());
            } finally {
                connected = false;
                dropNonLifecycle(outbox);
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, maxBackoffMs);
        }
    }

    private void writeLoop(Socket s, Writer out) throws IOException {
        while (running && !s.isClosed()) {
            JsonObject msg;
            try {
                msg = outbox.pollFirst(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                continue; // stop() interrupts us; the loop condition sees running == false
            }
            if (msg != null) writeLine(out, msg.toString());
        }
        if (s.isClosed()) throw new IOException("connection closed by hub");
        JsonObject msg;
        while ((msg = outbox.pollFirst()) != null) writeLine(out, msg.toString()); // stopping: flush what's left
    }

    private void readLoop(Socket s, BufferedReader in) {
        try {
            String line;
            while ((line = in.readLine()) != null) {
                JsonObject msg = parse(line);
                if (msg != null) inbox.add(msg);
            }
        } catch (IOException ignored) {} finally {
            closeQuietly(s);
        }
    }

    private static void writeLine(Writer out, String line) throws IOException {
        out.write(line);
        out.write('\n');
        out.flush();
    }

    static JsonObject parse(String line) {
        if (line == null) return null;
        try {
            JsonElement e = new JsonParser().parse(line);
            return e.isJsonObject() ? e.getAsJsonObject() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {}
    }
}

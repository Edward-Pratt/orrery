package io.github.edwardpratt.orrery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.BooleanSupplier;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class HubClientTest {

    /** Plays the hub's side of the protocol over a real socket. */
    static class FakeHub implements AutoCloseable {

        final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Socket socket;
        BufferedReader in;
        Writer out;

        FakeHub() throws IOException {
            server.setSoTimeout(5000);
        }

        void accept() throws IOException {
            socket = server.accept();
            socket.setSoTimeout(5000);
            in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        }

        JsonObject read() throws IOException {
            return HubClient.parse(in.readLine());
        }

        void write(String json) throws IOException {
            out.write(json + "\n");
            out.flush();
        }

        JsonObject handshake() throws IOException {
            accept();
            JsonObject hello = read();
            write("{\"type\":\"welcome\"}");
            return hello;
        }

        @Override
        public void close() throws IOException {
            if (socket != null) socket.close();
            server.close();
        }
    }

    FakeHub hub;
    HubClient client;

    @BeforeEach
    void setUp() throws IOException {
        hub = new FakeHub();
        client = new HubClient("127.0.0.1", hub.server.getLocalPort(), "gtnh", "secret-token-0123", "test");
        client.minBackoffMs = 50;
        client.maxBackoffMs = 200;
    }

    @AfterEach
    void tearDown() throws IOException {
        client.stop(1000);
        hub.close();
    }

    static JsonObject msg(String type) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        return o;
    }

    static void waitUntil(BooleanSupplier cond) throws InterruptedException {
        long end = System.currentTimeMillis() + 5000;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(10);
        }
    }

    @Test
    void handshakesThenSendsAndReceives() throws Exception {
        client.start();
        JsonObject hello = hub.handshake();
        assertEquals("hello", HubClient.str(hello, "type"));
        assertEquals("gtnh", HubClient.str(hello, "serverId"));
        assertEquals("secret-token-0123", HubClient.str(hello, "token"));
        assertEquals(
            1,
            hello.get("protocol")
                .getAsInt());
        waitUntil(client::isConnected);

        JsonObject chat = msg("chat");
        chat.addProperty("player", "Steve");
        chat.addProperty("message", "hi");
        client.send(chat);
        assertEquals(chat, hub.read());

        hub.write("{\"type\":\"say\",\"author\":\"Bob\",\"message\":\"yo\"}");
        waitUntil(() -> client.poll() != null);
    }

    @Test
    void whileDisconnectedKeepsOnlyLifecycleMessages() throws Exception {
        client.send(msg("chat"));
        client.send(msg("heartbeat"));
        client.send(msg("started"));
        client.start();
        hub.handshake();
        assertEquals("started", HubClient.str(hub.read(), "type"));
        waitUntil(client::isConnected);
        client.send(msg("join"));
        assertEquals("join", HubClient.str(hub.read(), "type"));
    }

    @Test
    void dropsOldestWhenOutboxIsFull() throws Exception {
        for (int i = 0; i <= HubClient.MAX_OUTBOX; i++) {
            JsonObject m = msg("started");
            m.addProperty("seq", i);
            client.send(m);
        }
        client.start();
        hub.handshake();
        assertEquals(
            1,
            hub.read()
                .get("seq")
                .getAsInt()); // seq 0 was dropped
    }

    @Test
    void reconnectsAfterTheHubDropsTheConnection() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        hub.socket.close();
        waitUntil(() -> !client.isConnected());
        hub.handshake();
        waitUntil(client::isConnected);
    }

    @Test
    void refusedConnectionStaysDisconnected() throws Exception {
        client.start();
        hub.accept();
        hub.read();
        hub.write("{\"type\":\"reject\",\"reason\":\"bad token\"}");
        assertNull(hub.in.readLine()); // client hangs up
        assertFalse(client.isConnected());
    }

    @Test
    void stopFlushesQueuedMessagesThenCloses() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        client.send(msg("stopping"));
        client.stop(2000);
        assertEquals("stopping", HubClient.str(hub.read(), "type"));
        assertNull(hub.in.readLine());
        assertTrue(!client.isConnected());
    }

    @Test
    void sendAfterStopNeverReachesTheHubOrReconnects() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        client.stop(2000);
        assertNull(hub.in.readLine());
        client.send(msg("stopping")); // what the JVM shutdown hook does after a clean /stop or a crash
        client.stop(2000);
        hub.server.setSoTimeout(500);
        assertThrows(SocketTimeoutException.class, hub.server::accept);
    }

    @Test
    void stopWithZeroTimeoutReturnsEvenIfTheHubNeverAnswers() throws Exception {
        client.start();
        hub.accept();
        hub.read(); // hello arrives, but no welcome is ever sent: the client is blocked reading
        assertTimeoutPreemptively(Duration.ofSeconds(2), () -> client.stop(0));
    }

    @Test
    void droppingStaleLinesKeepsOnlyLifecycleMessages() {
        java.util.Deque<JsonObject> queue = new java.util.ArrayDeque<>();
        queue.add(msg("chat"));
        queue.add(msg("started"));
        queue.add(msg("heartbeat"));
        queue.add(msg("stopping"));
        HubClient.dropNonLifecycle(queue);
        assertEquals(2, queue.size());
        assertEquals("started", HubClient.str(queue.pollFirst(), "type"));
        assertEquals("stopping", HubClient.str(queue.pollFirst(), "type"));
    }
}

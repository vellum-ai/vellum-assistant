import * as net from "node:net";

import {
  type ClientMessage,
  createMessageParser,
  serialize,
  type ServerMessage,
} from "../daemon/ipc-protocol.js";
import { IpcError } from "../util/errors.js";
import { getSocketPath, readSessionToken } from "../util/platform.js";

export function sendOneMessage(msg: ClientMessage): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getSocketPath());
    const parser = createMessageParser();
    let resolved = false;
    let authenticated = false;

    socket.on("connect", () => {
      // Authenticate first — the daemon requires a valid session token
      // before it will accept any other messages.
      const token = readSessionToken();
      if (!token) {
        resolved = true;
        reject(
          new IpcError("Session token not found — is the assistant running?"),
        );
        socket.destroy();
        return;
      }
      socket.write(serialize({ type: "auth", token }));
    });

    socket.on("data", (data) => {
      const messages = parser.feed(data.toString()) as ServerMessage[];
      for (const m of messages) {
        // Handle auth handshake
        if (!authenticated) {
          if (m.type === "auth_result") {
            if ((m as { success: boolean }).success) {
              authenticated = true;
              // Now send the actual message
              socket.write(serialize(msg));
            } else {
              resolved = true;
              reject(
                new IpcError(
                  (m as { message?: string }).message ??
                    "Authentication failed",
                ),
              );
              socket.destroy();
            }
          }
          continue;
        }

        // Skip push messages that aren't responses to our request
        if (m.type === "daemon_status") {
          continue;
        }
        // On auto-auth sockets the server may send a second auth_result
        // in response to the client's auth message after we're already
        // authenticated — ignore it so it doesn't resolve as the response.
        if (m.type === "auth_result") {
          continue;
        }
        if (m.type === "session_info" && msg.type !== "session_create") {
          continue;
        }
        resolved = true;
        socket.end();
        resolve(m);
        return;
      }
    });

    socket.on("error", (err) => {
      if (!resolved) reject(err);
    });

    socket.on("close", () => {
      if (!resolved) {
        reject(new IpcError("Socket closed before receiving a response"));
      }
    });
  });
}

import { EventEmitter } from "@mkellsy/event-emitter";
import { get as getLogger } from "js-logger";
import { connect, createSecureContext, TLSSocket } from "tls";

import { Certificate } from "../Response/Certificate";
import { Message } from "../Response/Message";

const log = getLogger("Socket");

const KEEPALIVE_INITIAL_DELAY = 10_000;
const INACTIVITY_TIMEOUT = 30_000;

/**
 * Creates a connections underlying socket.
 * @private
 */
export class Socket extends EventEmitter<{
    Error: (error: Error) => void;
    Data: (data: Buffer) => void;
    Disconnect: () => void;
}> {
    private connection?: TLSSocket;

    private readonly host: string;
    private readonly port: number;
    private readonly certificate: Certificate;

    /**
     * Creates a socket.
     *
     * @param host The IP address of the device.
     * @param port The port the device listenes on.
     * @param certificate An authentication certificate.
     */
    constructor(host: string, port: number, certificate: Certificate) {
        super();

        this.host = host;
        this.port = port;
        this.certificate = certificate;
    }

    /**
     * Establishes a connection to the device.
     *
     * @returns A connection protocol.
     */
    public connect(): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info(`TLS connect ${this.host}:${this.port}`);

            const connection = connect(this.port, this.host, {
                secureContext: createSecureContext(this.certificate),
                secureProtocol: "TLS_method",
                rejectUnauthorized: false,
            });

            connection.once("secureConnect", (): void => {
                this.connection = connection;

                this.connection.off("error", reject);

                this.connection.on("timeout", this.onSocketTimeout);
                this.connection.on("error", this.onSocketError);
                this.connection.on("close", this.onSocketClose);
                this.connection.on("data", this.onSocketData);

                this.connection.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY);
                this.connection.setTimeout(INACTIVITY_TIMEOUT);

                const protocol = this.connection.getProtocol() || "Unknown";

                log.info(`TLS secureConnect ${this.host}:${this.port} protocol=${protocol}`);
                resolve(protocol);
            });

            connection.once("error", (error) => {
                log.error(`TLS connect error ${this.host}:${this.port}: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * Disconnects from a device.
     */
    public disconnect(): void {
        this.connection?.end();
        this.connection?.destroy();
    }

    /**
     * Writes a message to the connection.
     *
     * @param message A message to write.
     */
    public write(message: Message): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.connection == null) return reject(new Error("connection not established"));

            this.connection.write(`${JSON.stringify(message)}\n`, (error) => {
                if (error != null) return reject(error);

                return resolve();
            });
        });
    }

    /*
     * Listens for data from the socket.
     */
    private onSocketData = (data: Buffer): void => {
        this.emit("Data", data);
    };

    /*
     * Listens for socket timeouts.
     */
    private onSocketTimeout = (): void => {
        log.warn(`TLS inactivity timeout ${this.host}:${this.port} (${INACTIVITY_TIMEOUT}ms)`);
        this.emit("Error", new Error("connect ETIMEDOUT"));
    };

    /*
     * Listenes for discrete disconects from the socket.
     */
    private onSocketClose = (): void => {
        log.info(`TLS close ${this.host}:${this.port}`);
        this.emit("Disconnect");
    };

    /*
     * Listenes for any errors from the socket. This will filter out any socket
     */
    private onSocketError = (error: Error): void => {
        log.error(`TLS error ${this.host}:${this.port}: ${error.message}`);
        this.emit("Error", error);
    };
}

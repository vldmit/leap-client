import fs from "fs";
import path from "path";
import os from "os";

import { BSON } from "bson";
import { get as getLogger } from "js-logger";

import { Certificate } from "../Response/Certificate";
import { ProcessorAddress } from "../Response/ProcessorAddress";

const log = getLogger("Context");

/**
 * Defines an authentication context and state for a processor.
 * @private
 */
export class Context {
    private context: Record<string, Certificate> = {};

    /**
     * Create an authentication context, and load any cached certificates. This
     * ensures that processors can be paired with device, and authentication
     * only happens once.
     */
    constructor() {
        try {
            const context = this.open<Record<string, Certificate>>("pairing") || {};
            const keys = Object.keys(context);

            for (let i = 0; i < keys.length; i++) {
                context[keys[i]] = this.decrypt(context[keys[i]])!;
            }

            this.context = context;

            const processors = this.processors;

            log.info(`pairing loaded: ${processors.length} processor(s) [${processors.join(", ") || "none"}]`);
        } catch (error) {
            log.error(
                `failed to load pairing from ~/.leap/pairing: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.context = {};
        }
    }

    /**
     * A list of processor ids currently paired.
     *
     * @returns A string array of processor ids.
     */
    public get processors(): string[] {
        return Object.keys(this.context).filter((key) => key !== "authority");
    }

    /**
     * Check to see if the context has a processor paired.
     *
     * @param id The processor id to check.
     *
     * @returns True if paired, false if not.
     */
    public has(id: string): boolean {
        return this.context[id] != null;
    }

    /**
     * Fetches the authentication certificate for a processor.
     *
     * @param id The processor id to fetch.
     *
     * @returns An authentication certificate or undefined if it doesn't exist.
     */
    public get(id: string): Certificate | undefined {
        return this.context[id];
    }

    /**
     * Adds a processor authentication certificate to the context.
     *
     * @param processor The processor address object to add.
     * @param context The authentication certificate to associate.
     */
    public set(processor: ProcessorAddress, context: Certificate): void {
        this.context[processor.id] = { ...context };
        this.save("pairing", this.context);
    }

    /*
     * Decrypts an authentication certificate.
     */
    private decrypt(context: Certificate | null): Certificate | null {
        if (context == null) return null;

        context.ca = Buffer.from(context.ca, "base64").toString("utf8");
        context.key = Buffer.from(context.key, "base64").toString("utf8");
        context.cert = Buffer.from(context.cert, "base64").toString("utf8");

        return context;
    }

    /*
     * Encrypts a certificate for storage. This ensures security at rest.
     */
    private encrypt(context: Certificate | null): Certificate | null {
        if (context == null) return null;

        context.ca = Buffer.from(context.ca).toString("base64");
        context.key = Buffer.from(context.key).toString("base64");
        context.cert = Buffer.from(context.cert).toString("base64");

        return context;
    }

    /*
     * Opens the context storage and loads paired processors.
     */
    private open<T>(filename: string): T | null {
        const directory = path.join(os.homedir(), ".leap");
        const filePath = path.join(directory, filename);

        if (!fs.existsSync(directory)) fs.mkdirSync(directory);

        if (fs.existsSync(filePath)) {
            const bytes = fs.readFileSync(filePath);
            const size = bytes != null && typeof (bytes as Buffer).length === "number" ? (bytes as Buffer).length : 0;

            log.info(`opened ${filePath} (${size} bytes)`);

            return BSON.deserialize(bytes) as T;
        }

        log.warn(`missing pairing file: ${filePath}`);

        return null;
    }

    /*
     * Saves the context to storage.
     */
    private save(filename: string, context: Record<string, Certificate>): void {
        const directory = path.join(os.homedir(), ".leap");

        if (!fs.existsSync(directory)) fs.mkdirSync(directory);

        const clear = { ...context };
        const keys = Object.keys(clear);

        for (let i = 0; i < keys.length; i++) {
            clear[keys[i]] = this.encrypt(clear[keys[i]])!;
        }

        fs.writeFileSync(path.join(directory, filename), BSON.serialize(clear));
    }
}

import {
  Chain,
  ClobClient,
  type ClobClientOptions,
} from "@polymarket/clob-client-v2";
import { AsyncLocalStorage } from "node:async_hooks";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import type { PolymarketWalletSignatureType } from "./browser-wallet-clob-signer.js";
import { OrderSubmissionNotSentError, type OrderSubmissionGuard } from "./order-adapter.js";

type ClobSigner = NonNullable<ClobClientOptions["signer"]>;
type ClientFactory = (options: ClobClientOptions) => ClobClient;
type SdkTransport = (endpoint: string, options?: unknown, skipThrow?: boolean) => Promise<unknown>;
type TransportClient = { post: SdkTransport; retryOnError: unknown };
const sdkTransportPost = (ClobClient.prototype as unknown as { post: SdkTransport }).post;
const sdkPostOrder = ClobClient.prototype.postOrder;

interface SubmissionContext {
  guard: OrderSubmissionGuard;
  sent: boolean;
}

export interface SessionAuthenticatedClobClientOptions {
  walletBinding: LiveWalletRuntimeBinding;
  signer: ClobSigner;
  signatureType: PolymarketWalletSignatureType;
  funderAddress: string;
  clobHost?: string;
  clientFactory?: ClientFactory;
}

/**
 * Lazily creates a Polymarket L2 client for one browser-wallet session.
 *
 * The browser signs the L1 CLOB authentication payload only when an
 * authenticated read or write is first requested. Derived API credentials are
 * retained solely inside the authenticated SDK instance and every reference is
 * dropped when the wallet session is disconnected, replaced, or expires.
 */
export class SessionAuthenticatedClobClient {
  private readonly clientFactory: ClientFactory;
  private readonly bootstrapClient: ClobClient;
  private readonly unsubscribe: () => void;
  private authenticated: ClobClient | null = null;
  private authenticating: Promise<ClobClient> | null = null;
  private invalidated = false;
  private readonly submissions = new AsyncLocalStorage<SubmissionContext>();
  private readonly guardedTransports = new WeakMap<ClobClient, SdkTransport>();

  constructor(private readonly options: SessionAuthenticatedClobClientOptions) {
    options.walletBinding.assertCurrent();
    if (options.walletBinding.session.chainId !== Chain.POLYGON) {
      throw new Error("LIVE_CLOB_POLYGON_MAINNET_REQUIRED");
    }
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ClobClient(clientOptions));
    this.bootstrapClient = this.clientFactory(this.baseOptions());
    this.unsubscribe = options.walletBinding.onInvalidated(() => {
      this.invalidate();
    });
  }

  async postOrder(...args: Parameters<ClobClient["postOrder"]>): Promise<Awaited<ReturnType<ClobClient["postOrder"]>>> {
    return this.runGuardedPost(args, { beforeSubmit() {} });
  }

  async postOrderGuarded(
    order: Parameters<ClobClient["postOrder"]>[0],
    orderType: Parameters<ClobClient["postOrder"]>[1],
    guard: OrderSubmissionGuard,
  ): Promise<Awaited<ReturnType<ClobClient["postOrder"]>>> {
    return this.runGuardedPost([order, orderType], guard);
  }

  async cancelOrder(...args: Parameters<ClobClient["cancelOrder"]>): Promise<Awaited<ReturnType<ClobClient["cancelOrder"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.cancelOrder(...args);
    this.assertCurrent();
    return result;
  }

  async getOrder(...args: Parameters<ClobClient["getOrder"]>): Promise<Awaited<ReturnType<ClobClient["getOrder"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.getOrder(...args);
    this.assertCurrent();
    return result;
  }

  async getOpenOrders(...args: Parameters<ClobClient["getOpenOrders"]>): Promise<Awaited<ReturnType<ClobClient["getOpenOrders"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.getOpenOrders(...args);
    this.assertCurrent();
    return result;
  }

  async getTrades(...args: Parameters<ClobClient["getTrades"]>): Promise<Awaited<ReturnType<ClobClient["getTrades"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.getTrades(...args);
    this.assertCurrent();
    return result;
  }

  async getBalanceAllowance(
    ...args: Parameters<ClobClient["getBalanceAllowance"]>
  ): Promise<Awaited<ReturnType<ClobClient["getBalanceAllowance"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.getBalanceAllowance(...args);
    this.assertCurrent();
    return result;
  }

  async updateBalanceAllowance(
    ...args: Parameters<ClobClient["updateBalanceAllowance"]>
  ): Promise<Awaited<ReturnType<ClobClient["updateBalanceAllowance"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.updateBalanceAllowance(...args);
    this.assertCurrent();
    return result;
  }

  async getClosedOnlyMode(
    ...args: Parameters<ClobClient["getClosedOnlyMode"]>
  ): Promise<Awaited<ReturnType<ClobClient["getClosedOnlyMode"]>>> {
    const client = await this.getAuthenticatedClient();
    this.assertCurrent();
    const result = await client.getClosedOnlyMode(...args);
    this.assertCurrent();
    return result;
  }

  async getFeeExponent(
    ...args: Parameters<ClobClient["getFeeExponent"]>
  ): Promise<Awaited<ReturnType<ClobClient["getFeeExponent"]>>> {
    this.assertCurrent();
    const result = await this.bootstrapClient.getFeeExponent(...args);
    this.assertCurrent();
    return result;
  }

  invalidate(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.authenticated = null;
    this.authenticating = null;
    this.unsubscribe();
  }

  private async runGuardedPost(args: Parameters<ClobClient["postOrder"]>, guard: OrderSubmissionGuard): Promise<Awaited<ReturnType<ClobClient["postOrder"]>>> {
    const context: SubmissionContext = { guard, sent: false };
    return this.submissions.run(context, async () => {
      try {
        const client = await this.getAuthenticatedClient();
        this.assertCurrent();
        this.installOrderTransportGuard(client);
        guard.beforeSubmit();
        const result = await client.postOrder(...args);
        if (!context.sent) throw new OrderSubmissionNotSentError("LIVE_CLOB_ORDER_TRANSPORT_NOT_USED");
        this.assertCurrent();
        return result;
      } catch (error) {
        if (!context.sent && !(error instanceof OrderSubmissionNotSentError)) {
          throw new OrderSubmissionNotSentError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    });
  }

  private installOrderTransportGuard(client: ClobClient): void {
    // Pinned SDK 1.0.8 calls its synchronous-to-transport private `post`
    // after awaiting server time and L2 headers. Reject changed/overridden
    // SDK structures instead of silently moving the guard before those awaits.
    const transport = client as unknown as TransportClient;
    const installed = this.guardedTransports.get(client);
    if (installed !== undefined) {
      if (transport.post !== installed || client.postOrder !== sdkPostOrder || transport.retryOnError !== false) {
        throw new OrderSubmissionNotSentError("LIVE_CLOB_ORDER_TRANSPORT_UNSUPPORTED");
      }
      return;
    }
    if (Object.getPrototypeOf(client) !== ClobClient.prototype || transport.post !== sdkTransportPost
      || client.postOrder !== sdkPostOrder || typeof sdkTransportPost !== "function" || transport.retryOnError !== false) {
      throw new OrderSubmissionNotSentError("LIVE_CLOB_ORDER_TRANSPORT_UNSUPPORTED");
    }
    const endpoint = `${(this.options.clobHost ?? "https://clob.polymarket.com").replace(/\/$/, "")}/order`;
    const owner = this;
    const guarded: SdkTransport = function (url, options, skipThrow) {
      const context = owner.submissions.getStore();
      if (context !== undefined || url === endpoint) {
        // A changed SDK must not relabel any error after an earlier POST as
        // definitely unsent, even if it unexpectedly re-enters this transport.
        if (context?.sent) throw new Error("LIVE_CLOB_ORDER_TRANSPORT_REENTERED_AFTER_POST");
        if (context === undefined || url !== endpoint) {
          throw new OrderSubmissionNotSentError("LIVE_CLOB_ORDER_TRANSPORT_CONTEXT_INVALID");
        }
        owner.assertCurrent();
        context.guard.beforeSubmit();
        context.sent = true;
      }
      return sdkTransportPost.call(client, url, options, skipThrow);
    };
    Object.defineProperty(client, "post", { value: guarded, configurable: false, writable: false });
    this.guardedTransports.set(client, guarded);
  }

  private async getAuthenticatedClient(): Promise<ClobClient> {
    this.assertCurrent();
    if (this.authenticated !== null) return this.authenticated;
    if (this.authenticating !== null) return this.authenticating;
    this.authenticating = this.authenticate();
    try {
      return await this.authenticating;
    } finally {
      this.authenticating = null;
    }
  }

  private async authenticate(): Promise<ClobClient> {
    const credentials = await this.createOrRecoverCredentials();
    this.assertCurrent();
    if (
      !credentials
      || typeof credentials.key !== "string"
      || typeof credentials.secret !== "string"
      || typeof credentials.passphrase !== "string"
      || !credentials.key
      || !credentials.secret
      || !credentials.passphrase
    ) {
      throw new Error("LIVE_CLOB_API_CREDENTIALS_INVALID");
    }
    const authenticated = this.clientFactory({
      ...this.baseOptions(),
      creds: credentials,
    });
    this.assertCurrent();
    this.authenticated = authenticated;
    return authenticated;
  }

  private async createOrRecoverCredentials(): Promise<Awaited<ReturnType<ClobClient["deriveApiKey"]>>> {
    try {
      return await this.bootstrapClient.createOrDeriveApiKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("could not create api key")) throw error;
      this.assertCurrent();
      return this.bootstrapClient.deriveApiKey();
    }
  }

  private baseOptions(): ClobClientOptions {
    return {
      host: this.options.clobHost ?? "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: this.options.signer,
      signatureType: this.options.signatureType,
      funderAddress: this.options.funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true,
    };
  }

  private assertCurrent(): void {
    if (this.invalidated) throw new Error("LIVE_CLOB_SESSION_INVALIDATED");
    this.options.walletBinding.assertCurrent();
  }
}

import { logger } from "../logger";

export type RequestPriority = "normal" | "high";

interface HttpClientRequestConfig {
  method: string;
  url: string;
  data?: any;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  priority?: RequestPriority;
}

interface HttpClientResponse<T> {
  status: number;
  statusText: string;
  data: T;
}

interface QueueItem<T = any> {
  config: HttpClientRequestConfig;
  resolve: (value: HttpClientResponse<T>) => void;
  reject: (reason?: unknown) => void;
}

interface QueueState {
  highPriorityQueue: QueueItem<any>[];
  normalPriorityQueue: QueueItem<any>[];
  isProcessingQueue: boolean;
  blockedUntil?: Date;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly body: string;

  constructor(options: { status: number; statusText: string; body: string }) {
    super(
      `HTTP error! status: ${options.status}, statusText: ${options.statusText}, body: ${options.body}`,
    );
    this.status = options.status;
    this.statusText = options.statusText;
    this.body = options.body;
  }
}

export class RateLimitedError extends HttpError {
  constructor(public readonly until: Date) {
    super({
      status: 429,
      statusText: "Too Many Requests",
      body: `Rate limited until ${until.toISOString()}`,
    });
  }
}

export const isTransientError = (error: unknown) =>
  !(error instanceof HttpError && error.status < 500);

const DEFAULT_RETRY_AFTER_MS = 1000;
const MAX_RETRY_429_WAIT_MS = 60_000;

function createQueueState(): QueueState {
  return {
    highPriorityQueue: [],
    normalPriorityQueue: [],
    isProcessingQueue: false,
  };
}

export class QueuedHttpClientFactory {
  private readonly queueState: QueueState = createQueueState();

  constructor(
    private readonly options: {
      baseURL: string;
      headers: Record<string, string>;
    },
  ) {}

  createClient(headers: Record<string, string>) {
    const mergedHeaders = { ...this.options.headers, ...headers };
    return new QueuedHttpClient(
      this.options.baseURL,
      mergedHeaders,
      this.queueState,
    );
  }
}

export class QueuedHttpClient {
  constructor(
    private readonly baseURL: string,
    private readonly headers: Record<string, string>,
    private readonly queueState: QueueState = createQueueState(),
  ) {}

  request<T = any>(
    config: HttpClientRequestConfig,
  ): Promise<HttpClientResponse<T>> {
    return new Promise<HttpClientResponse<T>>((resolve, reject) => {
      const queueItem: QueueItem<T> = {
        config: {
          ...config,
          headers: { ...this.headers, ...config.headers },
          url: config.url.startsWith("http")
            ? config.url
            : this.baseURL + config.url,
        },
        resolve,
        reject,
      };

      this.enqueue(queueItem);

      this.processQueue();
    });
  }

  get<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "get", url });
  }

  delete<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "delete", url });
  }

  head<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "head", url });
  }

  options<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "options", url });
  }

  post<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "post", url });
  }

  put<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "put", url });
  }

  patch<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "patch", url });
  }

  private processQueue() {
    if (this.queueState.isProcessingQueue) {
      return;
    }

    const next = this.dequeueNext();
    if (!next) {
      return;
    }

    this.queueState.isProcessingQueue = true;

    this.execute(next)
      .catch((error) => {
        next.reject(error);
      })
      .finally(() => {
        this.queueState.isProcessingQueue = false;
        this.processQueue();
      });
  }

  private async execute<T = any>(queueItem: QueueItem<T>) {
    const url = new URL(queueItem.config.url);

    if (queueItem.config.params) {
      Object.entries(queueItem.config.params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const payload: RequestInit = {
      method: queueItem.config.method,
      headers: queueItem.config.headers,
      body: queueItem.config.data
        ? JSON.stringify(queueItem.config.data)
        : undefined,
      credentials: "include",
    };

    // Only calls to the factory's API are rate limited, not the auth domain
    const isApiCall = queueItem.config.url.startsWith(this.baseURL);
    let waitedMs = 0;

    while (true) {
      const { blockedUntil } = this.queueState;
      if (isApiCall && blockedUntil && blockedUntil.getTime() > Date.now()) {
        throw new RateLimitedError(blockedUntil);
      }

      const response = await fetch(url, payload);

      if (response.ok) {
        const data = await response.json();
        queueItem.resolve({
          data,
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }

      const text = await response.text();
      const httpError = new HttpError({
        status: response.status,
        statusText: response.statusText,
        body: text,
      });

      if (response.status !== 429) {
        throw httpError;
      }

      const retryAfterMs = this.parseRetryAfterHeader(response);
      // At least 1s per retry, so Retry-After: 0 still uses up the budget
      const waitMs = Math.max(retryAfterMs, DEFAULT_RETRY_AFTER_MS);
      waitedMs += waitMs;
      const budgetExceeded = waitedMs > MAX_RETRY_429_WAIT_MS;
      // Once the budget is spent, back off for at least as long as the budget
      const until = new Date(
        Date.now() +
          (budgetExceeded
            ? Math.max(retryAfterMs, MAX_RETRY_429_WAIT_MS)
            : waitMs),
      );
      logger.warn(
        `Rate limited on ${url.origin}, Retry-After: ${retryAfterMs / 1000}s, until ${until.toISOString()}`,
      );

      if (budgetExceeded) {
        if (!isApiCall) {
          throw httpError;
        }
        this.queueState.blockedUntil = until;
        throw new RateLimitedError(until);
      }

      await this.sleep(waitMs);
    }
  }

  private enqueue(queueItem: QueueItem<any>) {
    if (queueItem.config.priority === "high") {
      this.queueState.highPriorityQueue.push(queueItem);
      return;
    }

    this.queueState.normalPriorityQueue.push(queueItem);
  }

  private dequeueNext() {
    return (
      this.queueState.highPriorityQueue.shift() ??
      this.queueState.normalPriorityQueue.shift()
    );
  }

  private parseRetryAfterHeader(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    const retryAfterValue = Array.isArray(retryAfter)
      ? retryAfter[0]
      : retryAfter;

    const retryAfterAsNumber = Number(retryAfterValue);
    if (!Number.isNaN(retryAfterAsNumber)) {
      return Math.max(0, retryAfterAsNumber * 1000);
    }

    const retryAtTimestamp = Date.parse(retryAfterValue);
    if (Number.isNaN(retryAtTimestamp)) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    return Math.max(0, retryAtTimestamp - Date.now());
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

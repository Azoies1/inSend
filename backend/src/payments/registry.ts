import type { AdapterName } from '../config';
import { FakeAdapter } from './adapters/fake/FakeAdapter';
import { RTRSimAdapter } from './adapters/rtr-sim/RTRSimAdapter';
import { loadRtrConfig } from './adapters/rtr-sim/config';
import { AdapterNotImplementedError, type PaymentProvider } from './provider';

/**
 * The one place that knows which adapters exist. Everything else receives a
 * PaymentProvider and cannot tell which adapter is behind it. Each adapter
 * reads its own settings from the environment.
 */
export function createProvider(
  adapter: AdapterName,
  env: Record<string, string | undefined> = process.env,
): PaymentProvider {
  switch (adapter) {
    case 'fake':
      return new FakeAdapter();
    case 'rtr-sim':
      return new RTRSimAdapter({ config: loadRtrConfig(env) });
    case 'zum': // Goal 3
      throw new AdapterNotImplementedError(adapter);
  }
}

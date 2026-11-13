import type { AdapterName } from '../config';
import { FakeAdapter } from './adapters/fake/FakeAdapter';
import { AdapterNotImplementedError, type PaymentProvider } from './provider';

/**
 * The one place that knows which adapters exist. Everything else receives a
 * PaymentProvider and cannot tell which adapter is behind it.
 */
export function createProvider(adapter: AdapterName): PaymentProvider {
  switch (adapter) {
    case 'fake':
      return new FakeAdapter();
    case 'rtr-sim': // Goal 2
    case 'zum': // Goal 3
      throw new AdapterNotImplementedError(adapter);
  }
}

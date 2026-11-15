// @vitest-environment jsdom
import { API, type NotificationConfigResponse } from '@webfront/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationsSection from './NotificationsSection';

const base: NotificationConfigResponse = {
  enabled: true,
  configured: true,
  token: { configured: true, hint: '…ijKL', source: 'saved' },
  userKey: { configured: true, hint: '…qPQR', source: 'saved' },
  options: {
    notifyDown: true,
    notifyRecovery: true,
    minDownMinutes: 0,
    repeatMinutes: 0,
    downPriority: 'normal',
    recoveryPriority: 'normal',
    device: null,
    sound: null,
  },
  delivery: { lastSuccessAt: null, lastErrorAt: null, lastError: null, paused: false },
};

const unconfigured: NotificationConfigResponse = {
  ...base,
  enabled: false,
  configured: false,
  token: { configured: false, hint: null, source: null },
  userKey: { configured: false, hint: null, source: null },
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let handler: (c: Call) => { status: number; body: unknown };

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(() => {
  calls = [];
  setOnline(true);
  handler = () => ({ status: 200, body: base });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tokenInput = () => screen.getByLabelText('API token (application)') as HTMLInputElement;
const userInput = () => screen.getByLabelText('User key') as HTMLInputElement;

describe('NotificationsSection', () => {
  it('shows only masked hints and password-type inputs', async () => {
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    expect(screen.getByText(/Saved \(…qPQR\)/)).toBeTruthy();
    for (const input of [tokenInput(), userInput()]) {
      expect(input.type).toBe('password');
      expect(input.getAttribute('autocomplete')).toBe('off');
      expect(input.value).toBe('');
    }
    expect(screen.getByRole('status', { name: 'Notification status' }).textContent).toContain(
      'Configured',
    );
  });

  it('saves options without re-entering the secrets', async () => {
    handler = (c) =>
      c.method === 'PUT'
        ? { status: 200, body: { ...base, options: { ...base.options, minDownMinutes: 5 } } }
        : { status: 200, body: base };
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    fireEvent.change(screen.getByLabelText('Alert after it has been down for'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(API.notifications);
    expect(put.body).toEqual({ enabled: true, options: { ...base.options, minDownMinutes: 5 } });
  });

  it('validates new secrets before sending and clears them after saving', async () => {
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    fireEvent.change(tokenInput(), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('An API token is 30 letters and digits.');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    const token = 'AppToken0123456789abcdefghijKL';
    fireEvent.change(tokenInput(), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ token });
    expect(put.body).not.toHaveProperty('userKey');
    expect(tokenInput().value).toBe('');
  });

  it('enables "Send test" only when configured and nothing unsaved, and reports errors', async () => {
    handler = () => ({ status: 200, body: unconfigured });
    const { unmount } = render(<NotificationsSection />);
    await screen.findByText('Save the API token and user key first.');
    expect((screen.getByRole('button', { name: 'Send test' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    unmount();

    handler = (c) =>
      c.method === 'POST'
        ? {
            status: 502,
            body: {
              error: {
                code: 'pushover_rejected',
                message: 'Pushover: user identifier is not a valid user',
              },
            },
          }
        : { status: 200, body: base };
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    const test = screen.getByRole('button', { name: 'Send test' }) as HTMLButtonElement;
    expect(test.disabled).toBe(false);

    fireEvent.change(userInput(), { target: { value: 'x' } });
    expect(test.disabled).toBe(true);
    expect(screen.getByText('Save the new credentials first.')).toBeTruthy();
    fireEvent.change(userInput(), { target: { value: '' } });
    expect(test.disabled).toBe(false);

    fireEvent.click(test);
    await screen.findByText('Pushover: user identifier is not a valid user');
    expect(calls.some((c) => c.method === 'POST' && c.path === API.notificationsTest)).toBe(true);

    handler = (c) =>
      c.method === 'POST'
        ? { status: 200, body: { ok: true, sentAt: '2026-03-01T12:00:00.000Z' } }
        : { status: 200, body: base };
    fireEvent.click(test);
    await screen.findByText('Test notification sent. Check your phone.');
  });

  it('shows the last delivery error and the pause', async () => {
    handler = () => ({
      status: 200,
      body: {
        ...base,
        delivery: {
          lastSuccessAt: null,
          lastErrorAt: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          lastError: 'Pushover: application token is invalid',
          paused: true,
        },
      },
    });
    render(<NotificationsSection />);
    await screen.findByText(/Last delivery failed: Pushover: application token is invalid/);
    expect(screen.getByText(/Alerts are paused/)).toBeTruthy();
  });

  it('is disabled with a reason when offline', async () => {
    setOnline(false);
    const { unmount } = render(<NotificationsSection />);
    expect(screen.getByText(/Connect to view or change them/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    unmount();

    setOnline(true);
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    await waitFor(() => expect(screen.getByText(/You are offline/)).toBeTruthy());
    for (const name of ['Save', 'Send test', 'Remove credentials']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(tokenInput().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Send test' }).getAttribute('title')).toBe(
      'Connect to the server to send a test.',
    );
  });

  it('removes credentials after confirmation', async () => {
    handler = (c) =>
      c.method === 'DELETE' ? { status: 200, body: unconfigured } : { status: 200, body: base };
    render(<NotificationsSection />);
    await screen.findByText(/Saved \(…ijKL\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove credentials' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('Saved credentials removed.');
    expect(
      calls.some((c) => c.method === 'DELETE' && c.path === API.notificationsCredentials),
    ).toBe(true);
  });
});

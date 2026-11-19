// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareDialog } from '../../src/components/ShareDialog';
import { ToastProvider } from '../../src/components/ui';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
    const body = handler(String(input), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('UI: Share with US dialog', () => {
  it('previews a list, lets the user exclude items and edit one, and sends only the selection', async () => {
    const calls: { url: string; body: any }[] = [];
    mockFetch((url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith('/share/preview')) {
        return {
          entries: [
            { id: 'a', title: 'Milk', quantity: 1, notes: '', module: 'grocery', grocery_state: 'need', duplicate: null, selected: true },
            { id: 'b', title: 'Bread', quantity: null, notes: '', module: 'grocery', grocery_state: 'need', duplicate: null, selected: true },
            { id: 'c', title: 'Eggs', quantity: 6, notes: '', module: 'grocery', grocery_state: 'need', duplicate: { id: 'x', title: 'Eggs', reason: 'already_shared' }, selected: false },
          ],
          target_lists: [{ id: 'l1', name: 'Our groceries', is_default: true }],
        };
      }
      return { created: [{ id: 'n1', title: 'Whole milk' }], skipped: [] };
    });
    const onClose = vi.fn();
    render(<ToastProvider><ShareDialog type="item" listId="list-1" onClose={onClose} /></ToastProvider>);
    await screen.findByDisplayValue('Milk');
    expect(screen.getByText('Already shared with US')).toBeTruthy();
    expect((screen.getByLabelText('Include Eggs') as HTMLInputElement).disabled).toBe(true);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Include Bread'));
    const title = screen.getByDisplayValue('Milk');
    await user.clear(title);
    await user.type(title, 'Whole milk');
    expect(screen.getByText('1 of 3 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Share 1 with US' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const share = calls.find((c) => c.url.endsWith('/api/share'))!;
    expect(share.body).toMatchObject({ type: 'item', ids: ['a'], mode: 'copy', target_list_id: 'l1', edits: { a: { title: 'Whole milk' } } });
  });

  it('makes moving explicit', async () => {
    mockFetch((url) => (url.endsWith('/share/preview')
      ? { entries: [{ id: 'a', title: 'Sofa', quantity: null, notes: '', module: 'home', grocery_state: null, duplicate: null, selected: true }], target_lists: [] }
      : { created: [], skipped: [] }));
    render(<ToastProvider><ShareDialog type="item" ids={['a']} onClose={() => {}} /></ToastProvider>);
    await screen.findByDisplayValue('Sofa');
    expect(screen.getByRole('button', { name: 'Share 1 with US' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Move to US' }));
    expect(screen.getByText(/leaves your private space/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move 1 to US' })).toBeTruthy();
  });
});

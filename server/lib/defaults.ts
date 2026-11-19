import type { Queryable } from '../db.js';

/** Restrained, consistent palette. Priority colours are mirrored in src/styles.css. */
export const GROCERY_CATEGORIES: { group: string; name: string; color: string }[] = [
  { group: 'Food and perishables', name: 'Vegetables', color: '#6f9a5b' },
  { group: 'Food and perishables', name: 'Fruit', color: '#d08a3c' },
  { group: 'Food and perishables', name: 'Meat and fish', color: '#b75d55' },
  { group: 'Food and perishables', name: 'Dairy', color: '#c9b26b' },
  { group: 'Food and perishables', name: 'Bakery', color: '#b98a5a' },
  { group: 'Food and perishables', name: 'Frozen', color: '#6a97b5' },
  { group: 'Food and perishables', name: 'Pantry', color: '#9b7b5b' },
  { group: 'Food and perishables', name: 'Beverages', color: '#5f8f8b' },
  { group: 'Food and perishables', name: 'Other food', color: '#8a8178' },
  { group: 'Household products', name: 'Cleaning supplies', color: '#5d8aa8' },
  { group: 'Household products', name: 'Laundry', color: '#7c8fb3' },
  { group: 'Household products', name: 'Bathroom', color: '#6fa3a0' },
  { group: 'Household products', name: 'Kitchen supplies', color: '#a38b6d' },
  { group: 'Household products', name: 'Personal care', color: '#b07c98' },
  { group: 'Household products', name: 'Home maintenance', color: '#7d7466' },
  { group: 'Household products', name: 'Other household items', color: '#8a8178' },
];

export const HOME_CATEGORIES = ['Furniture', 'Lighting', 'Storage', 'Decor', 'Textiles', 'Kitchen', 'Appliances', 'Electronics & gadgets', 'Tools', 'Repairs', 'Other'];
export const IDEA_CATEGORIES = ['Clothing', 'Shoes & accessories', 'Beauty & care', 'Gifts', 'Books & media', 'Sports & outdoors', 'Travel', 'Pets', 'Other'];

/** The three lists, by internal module name. */
export const LIST_NAMES = { grocery: 'Groceries', home: 'Home & Gadgets', idea: 'Shopping & Other' } as const;
export const ROOMS = ['Kitchen', 'Living room', 'Bedroom', 'Bathroom', 'Office', 'Hallway', 'Storage', 'Outdoor', 'Other'];

/** Create default lists and categories for a new workspace. */
export async function seedWorkspace(db: Queryable, workspaceId: string, userId: string, kind: 'personal' | 'shared') {
  const listNames: Record<string, string> = kind === 'shared'
    ? { ...LIST_NAMES }
    : { grocery: 'My groceries', home: 'My home & gadgets', idea: 'My shopping & other' };
  for (const [module, name] of Object.entries(listNames)) {
    await db.query('INSERT INTO lists (workspace_id, module, name, is_default, created_by) VALUES ($1,$2,$3,true,$4)', [workspaceId, module, name, userId]);
  }
  let i = 0;
  for (const c of GROCERY_CATEGORIES) {
    await db.query(
      'INSERT INTO categories (workspace_id, module, group_name, name, color, is_default, sort_order) VALUES ($1,$2,$3,$4,$5,true,$6)',
      [workspaceId, 'grocery', c.group, c.name, c.color, i++],
    );
  }
  i = 0;
  for (const name of HOME_CATEGORIES) {
    await db.query('INSERT INTO categories (workspace_id, module, name, is_default, sort_order) VALUES ($1,$2,$3,true,$4)', [workspaceId, 'home', name, i++]);
  }
  i = 0;
  for (const name of IDEA_CATEGORIES) {
    await db.query('INSERT INTO categories (workspace_id, module, name, is_default, sort_order) VALUES ($1,$2,$3,true,$4)', [workspaceId, 'idea', name, i++]);
  }
}

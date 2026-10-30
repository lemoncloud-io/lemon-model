/**
 * `fields/index.ts`
 * - field annotations of a model class: `@field()`, `fieldsOf()`, `specsOf()`.
 * - `field()` is dual-mode: legacy `(prototype, key)` (experimentalDecorators) and standard `(undefined, context)`.
 * - the field list is attached to the class itself under a `Symbol.for` key (never a module-level map),
 *   so the CJS and the ESM copy of this module read the same list.
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2026-10-28 initial version (lemon-core v5 B4)
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
// polyfill: standard decorators need `Symbol.metadata` (missing on Node 24); `Symbol.for` keeps every copy on one symbol.
(Symbol as any).metadata ??= Symbol.for('Symbol.metadata');

/** key of the own field list on a class (legacy) or on its metadata object (standard), shared by every module copy */
export const FIELDS_KEY: unique symbol = Symbol.for('lemon-model:fields:v1') as any;

/** kind of a field: `data` (default, stored), `view` (read-only view like `$`), `internal` (keys like `id`, `_id`) */
export type FieldKind = 'data' | 'view' | 'internal';

/** options of `@field()` */
export interface FieldOptions {
    /** field kind (default `data`) */
    kind?: FieldKind;
    /** projection group(s) (ex: `head`) */
    group?: string | string[];
}

/** one merged field spec (see `specsOf()`) */
export interface FieldSpec {
    /** field name */
    name: string;
    /** field kind after merge (default `data`) */
    kind: FieldKind;
    /** projection groups after merge */
    group: string[];
    /** true if the queried class itself declares this field */
    own: boolean;
}

/** query of `fieldsOf()` */
export interface FieldQuery {
    /** only fields whose groups include this group */
    group?: string;
    /** only fields of these kinds */
    kinds?: FieldKind[];
}

/** a class (abstract or not) that may carry field annotations */
type FieldHost = abstract new (...args: any[]) => any;

/** one raw declaration: field name + options as written */
interface FieldDecl {
    name: string;
    opts: FieldOptions;
}

/** own (non-inherited) declaration list of a holder; created non-enumerable on first write */
const ownDecls = (holder: any): FieldDecl[] => {
    if (Object.prototype.hasOwnProperty.call(holder, FIELDS_KEY)) return holder[FIELDS_KEY];
    const list: FieldDecl[] = [];
    Object.defineProperty(holder, FIELDS_KEY, { value: list, enumerable: false, configurable: true });
    return list;
};

/**
 * decorator factory of a model field (dual-mode).
 * - legacy: `@field() name?: string;` with `experimentalDecorators: true`.
 * - standard: same syntax with TS 5 standard decorators (needs `Symbol.metadata`, polyfilled above).
 *
 * @param opts  field options (`kind`, `group`)
 */
export const field =
    (opts: FieldOptions = {}) =>
    (target: any, context: any): any => {
        // standard call: (undefined, context) - store on the class metadata object
        if (context && typeof context === 'object' && typeof context.kind === 'string') {
            if (context.kind !== 'field') throw new Error(`@field() supports class fields only (got ${context.kind})`);
            if (context.static) throw new Error(`@field() does not support static fields (${String(context.name)})`);
            if (!context.metadata) throw new Error(`@field() needs Symbol.metadata - ${String(context.name)}`);
            ownDecls(context.metadata).push({ name: String(context.name), opts: { ...opts } });
            return undefined;
        }
        // legacy call: (prototype, key) - store on the class (constructor)
        if (typeof target === 'function')
            throw new Error(`@field() does not support static fields (${String(context)})`);
        ownDecls(target.constructor).push({ name: String(context), opts: { ...opts } });
        return undefined;
    };

/** constructor chain of `cls`, ordered root -> leaf */
const chainOf = (cls: any): any[] => {
    const out: any[] = [];
    for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) out.unshift(c);
    return out;
};

/** own declarations of one constructor from both stores (legacy first, then standard metadata) */
const declsOf = (ctor: any): FieldDecl[] => {
    const res: FieldDecl[] = [];
    // legacy store: own property of the constructor
    if (Object.prototype.hasOwnProperty.call(ctor, FIELDS_KEY)) res.push(...ctor[FIELDS_KEY]);
    // standard store: own list in the constructor's own metadata object
    const msym = (Symbol as any).metadata;
    const meta = msym && Object.prototype.hasOwnProperty.call(ctor, msym) ? ctor[msym] : undefined;
    if (meta && Object.prototype.hasOwnProperty.call(meta, FIELDS_KEY)) res.push(...meta[FIELDS_KEY]);
    return res;
};

/** normalize `group` option into a list */
const asGroups = (group: FieldOptions['group']): string[] =>
    group === undefined ? [] : Array.isArray(group) ? [...group] : [group];

/**
 * merged field specs of a model class.
 * - walks the chain root -> leaf; parent fields come first in declaration order.
 * - a redeclared name keeps the parent position, options merge as `{ ...parent, ...child }`.
 *
 * @param cls   model class
 */
export const specsOf = (cls: FieldHost): FieldSpec[] => {
    const merged = new Map<string, { opts: FieldOptions; own: boolean }>();
    // Map.set() on an existing key keeps its first (parent) position
    chainOf(cls).forEach(ctor =>
        declsOf(ctor).forEach(d => {
            const prev = merged.get(d.name);
            merged.set(d.name, { opts: { ...(prev ? prev.opts : {}), ...d.opts }, own: ctor === cls });
        }),
    );
    return [...merged.entries()].map(([name, { opts, own }]) => ({
        name,
        kind: opts.kind ?? 'data',
        group: asGroups(opts.group),
        own,
    }));
};

/**
 * field names of a model class, filtered by query.
 *
 * @param cls   model class
 * @param query optional `group` and `kinds` filter
 */
export const fieldsOf = (cls: FieldHost, query: FieldQuery = {}): string[] =>
    specsOf(cls)
        .filter(s => (query.group ? s.group.includes(query.group) : true))
        .filter(s => (query.kinds ? query.kinds.includes(s.kind) : true))
        .map(s => s.name);

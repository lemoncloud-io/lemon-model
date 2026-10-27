/**
 * `core-storage.ts`
 * - common types for core storage
 *
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2019-11-20 initial version
 * @date        2020-01-03 support cognito-identity
 * @date        2021-12-07 support SearchBody
 * @date        2026-10-28 `CoreModel` as a class with `@field()` annotations (lemon-core v5 B4)
 *
 * @copyright   (C) lemoncloud.io 2019 - All Rights Reserved.
 */
// field annotations for the `CoreModel` class
import { field, fieldsOf } from '../fields';

/**
 * only for type information for internal partition-key.
 */
export interface InternalKey {
    /** default partition-key name. */
    _id?: string;
}

/**
 * use shared `NoSQL` data storage. (ex: DynamoDB, MongoDB, ...)
 * - use `key-value` simple storage service.
 * - `no-search`: need to support 'search' function. (but scan)
 */
export interface StorageModel extends InternalKey {
    /** unique id value. */
    id?: string;
    /** type of data. */
    type?: string;
    /** stereo of type. */
    stereo?: string;
    /** json formated string (or parsed object). */
    meta?: string | any;
}

/**
 * class: `CoreModifier`
 * - common modifier information for core-model
 */
export interface CoreModifier {
    /**
     * site-id
     */
    sid?: string;
    /**
     * user-id
     */
    uid?: string;
    /**
     *  group-id
     */
    gid?: string;
}

/**
 * class: `InternalModel`
 * - common internal properties. (ONLY FOR INTERNAL PROCESSING)
 */
export interface InternalModel extends CoreModifier {
    /**
     * internal unique partition-key (valid if using default idName )
     */
    _id?: string;
}

/**
 * class: `CoreModel`
 * - general model out of base Model to support the common usage
 * - a class (not an interface) since 1.6.0: the fields carry `@field()` so `fieldsOf(CoreModel)` lists them.
 * - keep public optional fields only (no methods, no private members): object literals and
 *   `interface X extends CoreModel` must keep compiling.
 */
export class CoreModel<ModelType extends string = string> implements StorageModel, InternalModel {
    // view field: set by the storage layer, not saved as data
    /**
     * the last modifier info
     * - set automatically when model is created/updated/deleted.
     */
    @field({ kind: 'view' })
    readonly $?: CoreModifier;

    // data fields: the 13 common fields (`CORE_FIELDS` order)
    /**
     * namespace
     */
    @field()
    ns?: string;
    /**
     * type of model
     */
    @field()
    type?: ModelType;
    /**
     * stereo: stereo-type in common type.
     */
    @field()
    stereo?: string;
    /**
     * site-id
     */
    @field()
    sid?: string;
    /**
     * user-id
     */
    @field()
    uid?: string;
    /**
     *  group-id
     */
    @field()
    gid?: string;
    /**
     * lock count to secure sync
     */
    @field()
    lock?: number;
    /**
     * next sequence number (use `nextSeq()`)
     */
    @field()
    next?: number;
    /**
     * meta the json stringified string.
     */
    @field()
    meta?: string | any;
    /**
     * created timestamp
     */
    @field()
    createdAt?: number;
    /**
     * updated timestamp
     */
    @field()
    updatedAt?: number;
    /**
     * deleted timestamp
     */
    @field()
    deletedAt?: number;
    /**
     * error message will be set if error occurred
     */
    @field()
    error?: string;

    // internal fields: keys inherited from `StorageModel` / `InternalKey` (excluded from `CORE_FIELDS`)
    /**
     * unique id value. (from `StorageModel`)
     */
    @field({ kind: 'internal' })
    id?: string;
    /**
     * internal partition-key (from `InternalKey`)
     */
    @field({ kind: 'internal' })
    _id?: string;
}

// L1 core fields: view + data kinds of `CoreModel` (14, same order as the former literal list)
export const CORE_FIELDS: string[] = fieldsOf(CoreModel, { kinds: ['view', 'data'] });

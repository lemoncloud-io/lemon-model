/**
 * `core-storage.ts`
 * - common types for core storage
 *
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2019-11-20 initial version
 * @date        2020-01-03 support cognito-identity
 * @date        2021-12-07 support SearchBody
 *
 * @copyright   (C) lemoncloud.io 2019 - All Rights Reserved.
 */

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
 */
export interface CoreModel<ModelType extends string = string> extends StorageModel, InternalModel {
    /**
     * the last modifier info
     * - set automatically when model is created/updated/deleted.
     */
    readonly $?: CoreModifier;
    /**
     * namespace
     */
    ns?: string;
    /**
     * type of model
     */
    type?: ModelType;
    /**
     * stereo: stereo-type in common type.
     */
    stereo?: string;
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
    /**
     * lock count to secure sync
     */
    lock?: number;
    /**
     * next sequence number (use `nextSeq()`)
     */
    next?: number;
    /**
     * meta the json stringified string.
     */
    meta?: string | any;
    /**
     * created timestamp
     */
    createdAt?: number;
    /**
     * updated timestamp
     */
    updatedAt?: number;
    /**
     * deleted timestamp
     */
    deletedAt?: number;
    /**
     * error message will be set if error occurred
     */
    error?: string;
}

//NOTE! - BE WARE TO USE `ts-transformer-keys` DUE TO MISSING `ttypescript`
export const CORE_FIELDS: string[] = [
    '$',
    'ns',
    'type',
    'stereo',
    'sid',
    'uid',
    'gid',
    'lock',
    'next',
    'meta',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'error',
];

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
 * class: `InternalModel`
 * - common internal properties. (ONLY FOR INTERNAL PROCESSING)
 */
export interface InternalModel {
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
     * - initial site-id from `session-token` if use session
     */
    sid?: string;
    /**
     * user-id
     * - initial user-id from `session-token` if use session
     */
    uid?: string;
    /**
     *  group-id
     * - initial group-id from `session-token` if use session
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
     * last error message if error occurred
     */
    error?: string;

    /**
     * created timestamp
     * - initial created timestamp
     */
    createdAt?: number;
    /**
     * updated timestamp
     * - updated timestamp after modified
     */
    updatedAt?: number;
    /**
     * deleted timestamp
     * - deleted timestamp after removed
     */
    deletedAt?: number;

    /**
     * (optional) the modifier information.
     * - can't update manually.
     */
    readonly $?: CoreModifier;
}

/**
 * partial set of `CoreModel`
 */
export interface CoreModifier {
    /**
     *  auth-id of model
     * - inited by `session-token` if use session
     */
    aid?: string;
    /**
     * site-id of model
     * - inited by `session-token` if use session
     */
    sid?: string;
    /**
     * user-id of model
     * - inited by `session-token` if use session
     */
    uid?: string;
    /**
     *  group-id of model
     * - inited by `session-token` if use session
     */
    gid?: string;

    /**
     * (optinal) revision number
     * - manally incremented when updated
     */
    rev?: number;
}

//NOTE! - BE WARE TO USE `ts-transformer-keys` DUE TO MISSING `ttypescript`
// export const CORE_FIELDS: string[] = keys<CoreModel>().filter(_ => !_.startsWith('_'));
// _inf(NS, '! CORE_FIELDS =', CORE_FIELDS.join(', ')); // for debugging.
export const CORE_FIELDS: string[] =
    'ns,type,stereo,sid,uid,gid,lock,next,meta,error,$,createdAt,updatedAt,deletedAt'.split(',');

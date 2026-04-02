/**
 * `core-types.ts`
 * - common types for core service
 *
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2019-11-20 initial version
 * @date        2020-01-03 support cognito-identity
 * @date        2021-12-07 support SearchBody
 * @date        2024-12-20 optimized `NextIdentityCognito`
 * @date        2025-05-13 optimized `NextContext` with `Authorization` header
 * @date        2025-06-12 optimized `SearchBody` with `knn` support
 *
 * @copyright   (C) lemoncloud.io 2019 - All Rights Reserved.
 */

/**
 * class: `Incrementable`
 * - properties to support atomic increments
 */
export interface Incrementable {
    /**
     * fields to increment
     *  - number: increment number field
     *  - (string | number)[]: append to list(array) field
     */
    [key: string]: number | (string | number)[];
}

/**
 * class: `GeneralItem`
 * - general simple item model
 */
export interface GeneralItem {
    /**
     * only has simple string or number (and in arrays)
     */
    [key: string]: string | string[] | number | number[];
}

/**
 * type: simple data-types
 * - it should be compartible with elastic-search.
 * - it should be consistancy within same key name.
 */
export interface SimpleSet {
    /**
     * only has simple string or number w/o array.
     */
    [key: string]: string | number;
}

/** ********************************************************************************************************************
 *  COMMON Interfaces
 ** ********************************************************************************************************************/
/**
 * type: `NextMode`
 * - compartible with REST API Method.
 */
export type NextMode = 'LIST' | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * class: `NextIdentity`
 * - the context parameter for each next-handler `fx(id, param, body, context)`
 * - possible to query user's detail via OAuth Resource Server.
 */
export interface NextIdentity<T = any> {
    /**
     * site-id (like domain group)
     */
    sid?: string;
    /**
     * user-id (user id)
     */
    uid?: string;
    /**
     * group-id (group id)
     */
    gid?: string;
    /**
     * roles  (like `user`, `admin`, `super`)
     */
    roles?: string[];
    /**
     * prefered language (like 'ko')
     * - use `x-lemon-language` header, or in `x-lemon-identity`
     * @since ver2.2.3 2020/JUL/15
     */
    lang?: string;
    /**
     * (optional) internal last-error message
     * - if this is not empty, then DO NOT use this object.
     * @since ver3.1.2 2022/MAY/15
     */
    error?: string;
    /**
     * something unknown having the original data.
     */
    meta?: T;
}

/**
 * class: `NextIdentityJwt`
 * - JWT-Token based identity
 */
export interface NextIdentityJwt<T = any> extends NextIdentity<T> {
    /**
     * issuer of jwt
     * - must be in format of `kms/<alias>`
     */
    iss: string;
    /**
     * expired timestamp (sec)
     */
    exp: number;
    /**
     * issued timestamp (sec)
     */
    iat: number;
}

/**
 * class: `NextIdentityCognito`
 * - extended information w/ cognito identity.
 */
export interface NextIdentityCognito<T = any> extends NextIdentity<T> {
    /**
     * account-id of AWS Credential
     */
    accountId: string;
    /**
     * identity-id of cognito.
     */
    identityId: string;
    /**
     * identity-pool-id of cognito
     */
    identityPoolId: string;
    /**
     * authenticated provider of cognito like 'oauth.lemoncloud.io,oauth.lemoncloud.io:ap-northeast-2:618ce9d2-1234-2345-4567-e248ea51425e:kakao_00000'
     */
    identityProvider?: string;
    /**
     * user-agent string like 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_4)'
     */
    userAgent?: string;
    /**
     * (optional) caller string like `AROXXXXXX:CognitoIdentityCredentials` from `APIGatewayEventIdentity`
     * - available since `3.1.1`
     */
    caller?: string;
    /**
     * (optional) access-key used to sign.
     */
    accessKey?: string;
    /**
     * (optional) api-key if applicable.
     */
    apiKey?: string;
}

/**
 * class: `NextIdentityAcess`
 * - extended information w/ site + account access information.
 */
export interface NextIdentityAccess<T = any> extends NextIdentity<T> {
    /**
     * site-information for domain
     */
    Site?: {
        stereo?: string;
        name?: string;
        domain?: string;
    };
    /**
     * domain-information for current-access
     */
    Domain?: {
        stereo?: string;
        name?: string;
        domain?: string;
    };
    /**
     * user-information for active user.
     */
    User?: {
        name?: string;
        nick?: string;
        email?: string;
    };
    /**
     * group-information for groups.
     */
    Group?: {
        name?: string;
        roles?: string[];
    };
    /**
     * login account-information.
     */
    Account?: {
        id?: string;
        stereo?: string;
        socialId?: string;
        identityId?: string;
        loginId?: string;
    };
}

/**
 * class: `NextContext`
 * - information of caller's context w/ `next-identity`.
 */
export interface NextContext<T extends NextIdentity = NextIdentity> {
    /**
     * user identity after authentication.
     */
    identity?: T;
    /**
     * origin event source. can be 'express' if `npm run express.local`.
     */
    source?: string;
    /**
     * ip-address of source client.
     */
    clientIp?: string;
    /**
     * user-agent of source client.
     */
    userAgent?: string;
    /**
     * id of request to keep track of timing infor w/ `metrics`
     */
    requestId?: string;
    /**
     * id of aws account number from initial request. (ex: `085403634746` for lemon profile)
     */
    accountId?: string;
    /**
     * domain name of request.
     */
    domain?: string;
    /**
     * (optional) cookie string of origin request if available.
     */
    cookie?: {
        [key: string]: string;
    };
    /**
     * (optional) `authorization` in request headers if applicable.
     */
    authorization?: string;
    /**
     * (optional) `referer` in request headers if applicable.
     */
    referer?: string;
    /**
     * (optional) `origin` in request headers if applicable.
     */
    origin?: string;
    /**
     * calling depth for every handler. ( automatically increased from lambda-handler )
     */
    depth?: number;
}

/**
 * type: `NextHandler`
 * - basic form of next handler of contollers (as API)
 * - RestAPI 요청을 처리하는 콘트롤 함수.
 */
export type NextHandler<TParam = any, TResult = any, TBody = any> = (
    /**
     * resouce id
     */
    id?: string,
    /**
     * request's query-param
     */
    param?: TParam,
    /**
     * request's post|put payload
     */
    body?: TBody,
    /**
     * a context per each request.
     */
    $ctx?: NextContext,
) => Promise<TResult>;

/**
 * (optional) addition options for `.decode()` function.
 */
export interface NextDecoderOptions {
    /**
     * the full path to request.
     */
    path?: string;
    /**
     * the current context.
     */
    context?: NextContext;
}

/**
 * Decode `NextHandler` by mode + id + cmd (+ path)
 */
export type NextDecoder<TMode = NextMode> = (
    mode: TMode,
    id?: string,
    cmd?: string,
    options?: NextDecoderOptions,
) => NextHandler;

/** ********************************************************************************************************************
 *  Search Services
 ** ********************************************************************************************************************/

/**
 * class: QueryResult
 * - result information of query.
 */
export interface QueryResult<T> {
    // list of data
    list: T[];
    // number of data
    total?: number;
    // current page
    page?: number;
    // limit of list.
    limit?: number;
    // terms aggregations
    aggregations?: any;
    // last keys.
    last?: any;
}

/**
 * type: `QueryTerm`
 * - query term for search.
 * - it should be compartible with elastic-search.
 */
export type QueryTerm =
    | string
    | number
    | string[]
    | number[]
    | { query: string | number | string[] | number[]; operator?: 'and' | 'or'; slop?: number }
    | { query: { query_string: { default_field?: string; query: string } } };

/**
 * type: `SortTerm`
 * - sort term for search.
 * - it should be compartible with elastic-search.
 */
/* eslint-disable @typescript-eslint/indent */
export type SortTerm =
    | string
    | { [key: string]: 'asc' | 'desc' }
    | {
          [key: string]: {
              order?: 'asc' | 'desc';
              missing?: '_last' | '_first';
          };
      };
/* eslint-enable @typescript-eslint/indent */

/**
 * type: `SearchQuery`
 * - search query for elastic-search.
 * - it should be compartible with elastic-search.
 */
export interface SearchQuery {
    term?: { [key: string]: QueryTerm };
    terms?: { [key: string]: QueryTerm };
    match?: { [key: string]: QueryTerm };
    match_phrase?: { [key: string]: QueryTerm };
    prefix?: { [key: string]: QueryTerm };
    exists?: { field: string };
    range?: {
        [key: string]: {
            gt?: string | number;
            gte?: string | number;
            lt?: string | number;
            lte?: string | number;
            // like "dd/MM/yyyy||yyyy"
            format?: string;
        };
    };
    bool?: {
        filter?: SearchQuery | SearchQuery[];
        must?: SearchQuery | SearchQuery[];
        must_not?: SearchQuery | SearchQuery[];
        should?: SearchQuery | SearchQuery[];
        minimum_should_match?: number;
    };
    /** required to have mapping type: `knn_vector` */
    knn?: {
        /** field (ex: `vector$.sm3`) to query */
        [field: string]: {
            vector: number[];
            /** The number of nearest neighbors to return */
            k?: number;
            max_distance?: number;
            min_score?: number;
            filter?: SearchQuery;
            method_parameters?: {
                ef_search?: number;
                nprobes?: number;
            };
            rescore?:
                | {
                      oversample_factor?: number;
                  }
                | boolean;
            expand_nested_docs?: boolean;
        };
    };
    query_string?: { query: string };
}

export interface HighlightTerm {
    fields?: {
        [key: string]: {
            type?: 'unified' | string;
        };
    };
}

/**
 * type of search body
 */
export interface SearchBody {
    size?: number;
    from?: number;
    search_after?: (string | number)[];
    query?: SearchQuery;
    highlight?: HighlightTerm;
    sort?: SortTerm | SortTerm[];
    _source?: string[];
    aggs?: any;
}

/**
 * class: `SimpleSearchParam`
 * - simplified search param with json object.
 */
export interface SimpleSearchParam extends GeneralItem {
    $query?: string | any; // low query object.
    $limit?: number; // limit
    $page?: number; // page
    $Q?: string | any; // simple inline query
    $A?: string; // aggregation.
    $O?: string; // ordering.
    $H?: string; // highlight.
    $source?: string; // returned source fields set. '*', 'obj.*', '!abc'
    $exist?: string; // check if exists
    $exists?: string; // check if exists
}

/**
 * class: `AutocompleteSearchParam`
 *  - Search-as-You-Type
 */
export interface AutocompleteSearchParam {
    /**
     * query object. key as field to search and value as string to match
     */
    $query: {
        [field: string]: string;
    };
    /**
     * additional filter object.
     */
    $filter?: {
        [field: string]: string;
    };
    /**
     * maximum results in a page (default: 10)
     */
    $limit?: number; // limit
    /**
     * 0-indexed page number (default: 0)
     */
    $page?: number; // page
    /**
     * highlighting
     *  - if boolean is given, turn on/off highlighting (default: false)
     *  - if string is given, replace default highlighting tags (default: 'em')
     */
    $highlight?: boolean | string;
}

/**
 * feature: `DynamoSimpleQueriable`
 * - simple query capable class.
 */
export interface Elastic6SimpleQueriable<T extends GeneralItem> {
    /**
     * simple range query by `partition-key` w/ limit.
     *
     * @param id        value of id
     */
    queryAll(id: string, limit?: number, isDesc?: boolean): Promise<QueryResult<T>>;

    /**
     * search in simplemode
     *
     * @param param     SimpleSearchParam
     */
    searchSimple(param: SimpleSearchParam): Promise<QueryResult<T>>;
}

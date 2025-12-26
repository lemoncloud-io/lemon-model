/**
 * `transformer.ts`
 * - general transformer between `Model`, `View` and `Body`
 *
 *
 * @author      Steve <steve@lemoncloud.io>
 * @date        2023-01-19 initial version
 *
 * @copyright (C) 2023 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { CoreModel, CoreModifier } from '../types/core-storage';

/**
 * internal type `Model`
 */
type Model = CoreModel<string>;

/**
 * partial set of `CoreModel`
 */
export interface Cores extends Partial<CoreModifier> {
    /**
     * site-id of model
     * - inited by `identity-token` if use session
     */
    sid?: string;
    /**
     * user-id of model
     * - inited by `identity-token` if use session
     */
    uid?: string;
    /**
     *  group-id of model
     * - inited by `identity-token` if use session
     */
    gid?: string;
}

/**
 * common `View` types.
 * - layout of response.
 */
export interface View {
    /**
     * (optional) model's id
     */
    id?: string;
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
     * (optional) internal error.
     */
    error?: string;

    /**
     * (optional) internal cores modifier info.
     * - present if `hasCores` is true in `modelAsView()`
     * - or can be shown only if model has cores data.
     */
    readonly $?: Cores;
}

/**
 * common `Body` types.
 * - layout of request's body.
 */
export interface Body {
    /**
     * (optional) target model's id
     */
    id?: string;
}

/**
 * transform model to view, or body to model.
 * - required the sub-class model of `CoreModel`
 *
 * @see CoreModel
 */
export interface Transformable<MyModel extends Model, MyView extends View, MyBody extends Body> {
    /**
     * transform model to view
     * - result will be response json.
     *
     * @param model the data model.
     * @param hasCores (optional) include the properties in `CoreModel` as `$`
     */
    modelAsView: (model: MyModel, hasCores?: boolean) => MyView;

    /**
     * transform request-body to model.
     * - must check data types
     *
     * @param body the body posted
     * @param isCreate (optional) if body is for creation.
     */
    bodyToModel: (body: MyBody, isCreate?: boolean) => MyModel;
}

/**
 * reverse into model from remote view & body.
 */
export interface Reversable<Model, View = Model, Body = Model> {
    /**
     * convert response-view to model
     */
    asModel: (view: View) => Model;

    /**
     * convert model to request-body.
     */
    asBody: (model: Model) => Body;
}

/**
 * type: `AbstractTransformer`
 * - common base class of `Transformable`
 */
export abstract class AbstractTransformer<MyModel extends Model, MyView extends View, MyBody extends Body>
    implements Transformable<MyModel, MyView, MyBody>
{
    /**
     * check in date: YYYY-MM-DD
     *
     * @param val string
     * @param field (optional) target field name to use
     */
    public asDate = (val: string, field = 'date') => {
        if (!val || typeof val !== 'string') return '';
        const re = /^[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
        if (!re.test(val)) throw new Error(`.${field}[${val}] is invalid format - asDate()`);
        return val;
    };

    /**
     * extract only the defined attribute.
     * ex) `{ a:1, b: undefined }` -> `{ a:1 }`
     */
    public onlyDefined = <T extends object>(N?: T | null): T | null =>
        N === undefined || N === null
            ? N
            : N && typeof N === 'object'
            ? Object.entries(N).reduce<T>((N, [k, v]) => {
                  if (v !== undefined) N[k as keyof T] = v;
                  return N;
              }, {} as T)
            : null;

    /**
     * transform the cores data
     * @param cores the cores data to transform
     * @returns transformed cores data or null
     */
    public asCore<T extends Cores>(cores?: T | null): T | null {
        if (!cores || typeof cores !== 'object') return null;
        const ret = {} as T;
        if (cores.sid !== undefined) ret.sid = String(cores.sid);
        if (cores.gid !== undefined) ret.gid = String(cores.gid);
        if (cores.uid !== undefined) ret.uid = String(cores.uid);
        return this.onlyDefined<T>(ret);
    }

    /**
     * transform from model to view
     *
     * @see Transformable.modelAsView
     */
    public modelAsView(model?: MyModel | null, hasCores?: boolean): MyView {
        if (!model || typeof model !== 'object') return null;
        const view = this.onlyDefined<View>({
            $: model?.$ ?? undefined, // if null, remove it
            id: model.id,
            createdAt: model.createdAt,
            updatedAt: model.updatedAt,
            deletedAt: model.deletedAt,
        });
        if (model.error) view.error = model.error;
        if (hasCores) {
            const $ = this.asCore<Cores>(model);
            Object.assign(view, { $ });
        }
        return this.onlyDefined<MyView>(view as MyView);
    }

    /**
     * transform from body(req-body) to model
     *
     * @see Transformable.bodyToModel
     */
    public bodyToModel(body: MyBody | any, isCreate?: boolean): MyModel {
        if (!body || typeof body !== 'object') return null;
        const model = {} as MyModel;

        if (body?.id !== undefined) model.id = `${body.id ?? ''}`;

        return model as MyModel;
    }
}

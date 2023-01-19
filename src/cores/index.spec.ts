/**
 * `common.spec.ts`
 * - common for test script
 *
 *
 * @author      Steve <steve@lemoncloud.io>
 * @date        2023-01-19 initial version
 *
 * @copyright (C) 2023 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { CoreModel, SimpleSet } from '../types/';
import { View, Body, AbstractTransformer } from '../cores/';
export type ModelType = 'test';
export type Model = CoreModel<ModelType>;

/**
 * `test`: sample test model.
 */
export interface TestModel extends Model {
    /** name of model */
    name?: string;
    /** test count */
    test?: number;
    /** boolean number */
    bool?: number;
    /** (optional) extra */
    extra?: SimpleSet;
}

/**
 * view of model
 */
export interface MyView extends View, Omit<Partial<TestModel>, 'bool'> {
    /**
     * text in korean
     */
    ko: string;
    /**
     * as boolean
     */
    bool?: boolean;
}

/**
 * body to post
 */
export interface MyBody extends Body, Partial<MyView> {}

/**
 * transformer
 */
export class TestTransformer extends AbstractTransformer<TestModel, MyView, MyBody> {
    public modelAsView(model: TestModel, hasCores?: boolean): MyView {
        const view = super.modelAsView(model, hasCores);
        if (!view) return view;
        return this.onlyDefined({
            ...view,
            ko: '',
            name: model.name,
            test: typeof model.test === 'number' ? model.test : undefined,
            bool: typeof model.bool === 'number' ? Boolean(model.bool) : undefined,
        });
    }
    public bodyToModel(body: MyBody, isCreate?: boolean): TestModel {
        const model = super.bodyToModel(body, isCreate);
        if (!model) return model;
        if (body?.name !== undefined) model.name = String(body.name);
        if (body?.test !== undefined) model.test = Number(body.test);
        if (body?.bool !== undefined) model.bool = Number(body.bool === true ? 1 : body.bool);
        return model;
    }
}

/**
 * catch error as string
 *
 * ```js
 * const a = sync () => throw new Error('ERROR');
 * expect(await a().catch(GETERR)).toEqual('ERROR');
 * ```
 * @param e
 */
export const GETERR = (e: any) =>
    e instanceof Error ? `${e.message}` : e && typeof e == 'object' ? JSON.stringify(e) : `${e}`;

/**
 * catch error as { error: string }
 *
 * ```js
 * const a = sync () => throw new Error('ERROR');
 * expect(await a().catch(GETERR$)).toEqual({ error:'ERROR' })
 * ```
 * @param e
 */
export const GETERR$ = (e: any) => ({ error: GETERR(e) });

/**
 * return null if 404 not found.
 * @param e error
 */
export const NUL404 = (e: Error) => {
    if (`${e.message}`.startsWith('404 NOT FOUND')) return null as any;
    throw e;
};

/**
 * improve expect() function with projection field.
 *
 * @param test      function or data.
 * @param view      projection attributes.
 */
export const expect2 = (test: any, view?: string): any => {
    const project = (data: any): any => {
        if (!view) return data;
        if (data === null || data === undefined) return data;
        if (typeof data != 'object') return data;
        if (Array.isArray(data)) {
            return (data as any[]).map(project);
        }
        const views = view.split(',');
        const excludes = views.filter(_ => _.startsWith('!')).map(_ => _.substring(1));
        const includes = views.filter(_ => !_.startsWith('!')).map(_ => _.substring(0));
        const V = excludes.reduce((N: any, key) => {
            delete N[key];
            return N;
        }, data);
        if (includes.length < 1) return V; // if no includes.
        return includes.reduce((N: any, key) => {
            N[key] = V[key];
            return N;
        }, {});
    };
    try {
        const ret = typeof test == 'function' ? test() : test;
        if (ret instanceof Promise) {
            return expect(ret.then(project).catch(GETERR)).resolves;
        } else {
            return expect(project(ret));
        }
    } catch (e) {
        return expect(GETERR(e));
    }
};

describe('index', () => {
    //! test transformer
    it('should pass basic test', async () => {
        expect2(() => GETERR(new Error('some'))).toEqual('some');
    });
});

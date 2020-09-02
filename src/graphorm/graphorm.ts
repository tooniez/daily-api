/* eslint-disable @typescript-eslint/no-explicit-any */

import { GraphQLResolveInfo } from 'graphql';
import { SelectQueryBuilder, EntityMetadata } from 'typeorm';
import { parseResolveInfo, ResolveTree } from 'graphql-parse-resolve-info';
import { Context } from '../Context';
import { Connection, Edge } from 'graphql-relay';

export type QueryBuilder = SelectQueryBuilder<any>;

export type GraphORMBuilder = { queryBuilder: QueryBuilder; alias: string };
export interface GraphORMRelation {
  isMany: boolean;
  parentColumn?: string;
  childColumn?: string;
  customRelation?: (
    ctx: Context,
    parentAlias: string,
    childAlias: string,
    qb: QueryBuilder,
  ) => QueryBuilder;
}

export interface GraphORMField {
  // Define the column to select or provide a custom function
  select?:
    | string
    | ((ctx: Context, alias: string, qb: QueryBuilder) => QueryBuilder);
  // Add custom settings to the query (should be used for complex types only!)
  customQuery?: (ctx: Context, alias: string, qb: QueryBuilder) => QueryBuilder;
  // Need to provide relation information if it doesn't exist
  relation?: GraphORMRelation;
  // Apply this function on the value after querying the database
  transform?: (value: any, ctx: Context) => any;
  // Specify if this field is an alias to another field
  alias?: { field: string; type: string };
}

export interface GraphORMType {
  // Define manually the table to select from
  from?: string;
  // Define fields customizations
  fields?: { [name: string]: GraphORMField };
  // Array of columns to select regardless of the resolve tree
  requiredColumns?: string[];
}

// Define custom mapping to types
export interface GraphORMMapping {
  [name: string]: GraphORMType;
}

export class GraphORM {
  mappings: GraphORMMapping | null;

  constructor(mappings?: GraphORMMapping) {
    this.mappings = mappings;
  }

  /**
   * Finds the relation between parent and child entities
   * @param parentMetadata Parent entity metadata
   * @param childMetadata Child entity metadata
   */
  findRelation(
    parentMetadata: EntityMetadata,
    childMetadata: EntityMetadata,
  ): GraphORMRelation {
    const relation = childMetadata.relations.find(
      (rel) => rel.inverseEntityMetadata.name === parentMetadata.name,
    );
    if (relation) {
      const fk = relation.foreignKeys[0];
      return {
        isMany: relation.relationType === 'many-to-one',
        parentColumn: fk.referencedColumnNames[0],
        childColumn: fk.columnNames[0],
      };
    }
    const inverseRelation = parentMetadata.relations.find(
      (rel) => rel.inverseEntityMetadata.name === childMetadata.name,
    );
    if (inverseRelation) {
      const fk = inverseRelation.foreignKeys[0];
      return {
        isMany: inverseRelation.relationType === 'one-to-many',
        parentColumn: fk.columnNames[0],
        childColumn: fk.referencedColumnNames[0],
      };
    }
    return null;
  }

  /**
   * Add a selection of a complex field to the query builder
   * @param ctx GraphQL context of the request
   * @param builder Select query builder to augment with new field
   * @param alias Alias of the parent table
   * @param metadata Parent entity metadata (from TypeORM)
   * @param type Name of the GraphQL parent type
   * @param field Resolve tree of the field
   * @param childType Type of the child field to query
   */
  selectComplexField(
    ctx: Context,
    builder: QueryBuilder,
    alias: string,
    metadata: EntityMetadata,
    type: string,
    field: ResolveTree,
    childType: string,
  ): QueryBuilder {
    const relation =
      this.mappings?.[type]?.fields?.[field.name]?.relation ||
      this.findRelation(metadata, ctx.con.getMetadata(childType));
    if (!relation) {
      throw new Error(`Could not find relation ${type}.${field.name}`);
    }
    const select = relation.isMany
      ? `coalesce(jsonb_agg(res), '[]'::jsonb)`
      : `to_jsonb(res)`;
    // Aggregate results as jsonb
    return builder.select(select, 'children').from((subBuilder) => {
      // Select all sub fields
      const childBuilder = this.selectType(
        ctx,
        subBuilder,
        childType,
        field.fieldsByTypeName[childType],
      );
      if (relation.customRelation) {
        childBuilder.queryBuilder = relation.customRelation(
          ctx,
          alias,
          childBuilder.alias,
          childBuilder.queryBuilder,
        );
      } else {
        // Add where clause to fetch children by relation
        childBuilder.queryBuilder = childBuilder.queryBuilder.where(
          `"${childBuilder.alias}"."${relation.childColumn}" = "${alias}"."${relation.parentColumn}"`,
        );
      }
      if (!relation.isMany) {
        childBuilder.queryBuilder = childBuilder.queryBuilder.limit(1);
      }
      // Apply custom query if any
      const customQuery = this.mappings?.[type]?.fields?.[field.name]
        ?.customQuery;
      if (customQuery) {
        return customQuery(ctx, childBuilder.alias, childBuilder.queryBuilder);
      }
      return childBuilder.queryBuilder;
    }, 'res');
  }

  /**
   * Add a selection of a given field to the query builder
   * @param ctx GraphQL context of the request
   * @param builder Select query builder to augment with new field
   * @param alias Alias of the parent table
   * @param metadata Parent entity metadata (from TypeORM)
   * @param type Name of the GraphQL parent type
   * @param field Resolve tree of the field
   */
  selectField(
    ctx: Context,
    builder: QueryBuilder,
    alias: string,
    metadata: EntityMetadata,
    type: string,
    field: ResolveTree,
  ): QueryBuilder {
    const childType = Object.keys(field.fieldsByTypeName)[0];
    const mapping = this.mappings?.[type]?.fields?.[field.name];
    if (mapping?.alias) {
      const fieldsByTypeName = childType
        ? {
            [mapping.alias.type]: field.fieldsByTypeName[childType],
          }
        : field.fieldsByTypeName;
      return this.selectField(ctx, builder, alias, metadata, type, {
        ...field,
        name: mapping.alias.field,
        alias: mapping.alias.field,
        fieldsByTypeName,
      });
    }

    if (childType) {
      // If current field is a of custom type
      return builder.addSelect(
        (subBuilder) =>
          this.selectComplexField(
            ctx,
            subBuilder,
            alias,
            metadata,
            type,
            field,
            childType,
          ),
        field.alias,
      );
    }
    // Else, scalar value
    if (mapping) {
      const { select } = mapping;
      if (select) {
        if (typeof select === 'string') {
          return builder.addSelect(`"${alias}"."${select}"`, field.alias);
        }
        return builder.addSelect(
          (subBuilder) => select(ctx, alias, subBuilder),
          field.alias,
        );
      }
    }
    if (metadata.findColumnWithPropertyName(field.name)) {
      return builder.addSelect(`"${alias}"."${field.name}"`, field.alias);
    }
    return builder;
  }

  /**
   * Adds a selection of a given type to the query builder
   * @param ctx GraphQL context of the request
   * @param builder Select query builder to augment with new field
   * @param type Name of the GraphQL type
   * @param fieldsByTypeName Requested fields for the given type
   */
  selectType(
    ctx: Context,
    builder: QueryBuilder,
    type: string,
    fieldsByTypeName: { [p: string]: ResolveTree },
  ): GraphORMBuilder {
    const fields = Object.values(fieldsByTypeName);
    const entityMetadata = ctx.con.getMetadata(
      this.mappings?.[type]?.from || type,
    );
    const alias = entityMetadata.tableName.toLowerCase();
    let newBuilder = builder.from(entityMetadata.tableName, alias).select([]);
    fields.forEach((field) => {
      newBuilder = this.selectField(
        ctx,
        newBuilder,
        alias,
        entityMetadata,
        type,
        field,
      );
    });
    (this.mappings?.[type]?.requiredColumns ?? []).forEach((col) => {
      newBuilder = newBuilder.addSelect(`${alias}."${col}"`, col);
    });
    return { queryBuilder: newBuilder, alias };
  }

  /**
   * Transforms a given field after the query
   * @param ctx GraphQL context of the request
   * @param parentType Name of the GraphQL parent type
   * @param field Resolve tree of the field
   * @param value A single query result
   */
  transformField(
    ctx: Context,
    parentType: string,
    field: ResolveTree,
    value: any,
  ): any {
    if (this.mappings?.[parentType]?.fields?.[field.name]?.transform) {
      return this.mappings[parentType].fields[field.name].transform(value, ctx);
    }
    if (value === null || value === undefined) {
      return value;
    }
    const childType = Object.keys(field.fieldsByTypeName)[0];
    if (childType) {
      // If current field is a of custom type
      if (Array.isArray(value)) {
        // If value is an array
        return value.map((element) =>
          this.transformType(
            ctx,
            element,
            childType,
            field.fieldsByTypeName[childType],
          ),
        );
      }
      return this.transformType(
        ctx,
        value,
        childType,
        field.fieldsByTypeName[childType],
      );
    }
    return value;
  }

  /**
   * Transforms a given type after the query
   * @param ctx GraphQL context of the request
   * @param value A single query result
   * @param type Name of the GraphQL type
   * @param fieldsByTypeName Requested fields for the given type
   */
  transformType<T>(
    ctx: Context,
    value: object,
    type: string,
    fieldsByTypeName: ResolveTree | { [p: string]: ResolveTree },
  ): T {
    const fields = Object.values(fieldsByTypeName);
    return fields.reduce(
      (acc, field) => ({
        ...acc,
        [field.alias]: this.transformField(
          ctx,
          type,
          field,
          value[field.alias],
        ),
      }),
      value,
    );
  }

  /**
   * Get the resolve tree of a field by its hierarchy
   * @param info GraphQL resolve info
   * @param hierarchy Array of field names
   */
  getFieldByHierarchy(info: ResolveTree, hierarchy: string[]): ResolveTree {
    const root = info.fieldsByTypeName?.[Object.keys(info.fieldsByTypeName)[0]];
    const child = Object.values(root).find(
      (field) => field.name === hierarchy[0],
    );
    if (hierarchy.length === 1) {
      return child;
    }
    return this.getFieldByHierarchy(child, hierarchy.slice(1));
  }

  /**
   * Returns the type of the requested paginated object (Relay style)
   * @param info GraphQL resolve tree
   */
  getPaginatedField(info: ResolveTree): ResolveTree {
    return this.getFieldByHierarchy(info, ['edges', 'node']);
  }

  async queryResolveTree<T>(
    ctx: Context,
    resolveTree: ResolveTree,
    beforeQuery?: (builder: GraphORMBuilder) => GraphORMBuilder,
  ): Promise<T[]> {
    const rootType = Object.keys(resolveTree.fieldsByTypeName)[0];
    const fieldsByTypeName = resolveTree.fieldsByTypeName[rootType];
    let builder = this.selectType(
      ctx,
      ctx.con.createQueryBuilder(),
      rootType,
      fieldsByTypeName,
    );
    if (beforeQuery) {
      builder = beforeQuery(builder);
    }
    const res = await builder.queryBuilder.getRawMany();
    return res.map((value) =>
      this.transformType(ctx, value, rootType, fieldsByTypeName),
    );
  }

  /**
   * Queries the database to fulfill a GraphQL request
   * @param ctx GraphQL context of the request
   * @param resolveInfo GraphQL resolve info of the request
   * @param beforeQuery A callback function that is called before executing the query
   */
  query<T>(
    ctx: Context,
    resolveInfo: GraphQLResolveInfo,
    beforeQuery?: (builder: GraphORMBuilder) => GraphORMBuilder,
  ): Promise<T[]> {
    const parsedInfo = parseResolveInfo(resolveInfo) as ResolveTree;
    if (parsedInfo) {
      return this.queryResolveTree(ctx, parsedInfo, beforeQuery);
    }
    throw new Error('Resolve info is empty');
  }

  /**
   * Queries the database to fulfill a GraphQL request.
   * Response is returned in a Relay style pagination object.
   * @param ctx GraphQL context of the request
   * @param resolveInfo GraphQL resolve info of the request
   * @param hasPreviousPage Whether there is a previous page (used for PageInfo)
   * @param hasNextPage Whether there is a previous page (used for PageInfo)
   * @param nodeToCursor A function that creates a cursor from a node
   * @param beforeQuery A callback function that is called before executing the query
   * @param transformNodes Apply any transformation on the nodes before adding page info
   */
  async queryPaginated<T>(
    ctx: Context,
    resolveInfo: GraphQLResolveInfo,
    hasPreviousPage: (nodeSize: number) => boolean,
    hasNextPage: (nodeSize: number) => boolean,
    nodeToCursor: (node: T, index: number) => string,
    beforeQuery?: (builder: GraphORMBuilder) => GraphORMBuilder,
    transformNodes?: (nodes: T[]) => T[],
  ): Promise<Connection<T>> {
    const parsedInfo = parseResolveInfo(resolveInfo) as ResolveTree;
    if (parsedInfo) {
      const resolveTree = this.getPaginatedField(parsedInfo);
      let nodes = await this.queryResolveTree<T>(ctx, resolveTree, beforeQuery);
      if (transformNodes) {
        nodes = transformNodes(nodes);
      }
      if (!nodes.length) {
        return {
          pageInfo: {
            startCursor: null,
            endCursor: null,
            hasNextPage: hasNextPage(nodes.length),
            hasPreviousPage: hasPreviousPage(nodes.length),
          },
          edges: [],
        };
      }
      const edges = nodes.map(
        (n, i): Edge<T> => ({
          node: n,
          cursor: nodeToCursor(n, i),
        }),
      );
      return {
        pageInfo: {
          startCursor: edges[0].cursor,
          endCursor: edges[edges.length - 1].cursor,
          hasNextPage: hasNextPage(nodes.length),
          hasPreviousPage: hasPreviousPage(nodes.length),
        },
        edges,
      };
    }
    throw new Error('Resolve info is empty');
  }
}
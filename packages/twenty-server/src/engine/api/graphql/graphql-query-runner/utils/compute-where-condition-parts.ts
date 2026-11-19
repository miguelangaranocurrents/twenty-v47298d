import { randomBytes } from 'crypto';

import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type ObjectLiteral } from 'typeorm';

import { findPostgresDefaultNullEquivalentValue } from 'src/engine/api/common/common-args-processors/data-arg-processor/utils/find-postgres-default-null-equivalent-value.util';
import { STANDARD_ERROR_MESSAGE } from 'src/engine/api/common/common-query-runners/errors/standard-error-message.constant';
import {
  GraphqlQueryRunnerException,
  GraphqlQueryRunnerExceptionCode,
} from 'src/engine/api/graphql/graphql-query-runner/errors/graphql-query-runner.exception';
import { formatSearchTerms } from 'src/engine/core-modules/search/utils/format-search-terms';

type WhereConditionParts = {
  sql: string;
  params: ObjectLiteral;
};

// These operators stay TRUE or FALSE on NULL operands, so negating them already keeps NULL rows
const NULL_INSENSITIVE_OPERATORS = new Set([
  'is',
  'isStrictly',
  'isEmptyArray',
]);

const computeBaseWhereConditionParts = ({
  operator,
  objectNameSingular,
  key,
  subFieldKey,
  value,
  fieldMetadataType,
  useDirectTableReference = false,
}: {
  operator: string;
  objectNameSingular: string;
  key: string;
  subFieldKey?: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  value: any;
  fieldMetadataType: FieldMetadataType;
  useDirectTableReference?: boolean;
}): WhereConditionParts => {
  const paramSuffix = randomBytes(5).toString('hex');

  const secondParamSuffix = randomBytes(5).toString('hex');

  const fieldReference = useDirectTableReference
    ? `"${key}"`
    : `"${objectNameSingular}"."${key}"`;

  const isDateTimeField = fieldMetadataType === FieldMetadataType.DATE_TIME;

  //TODO : Remove filter null equivalence injection once feature flag removed + null equivalence transformation added in ORM
  const nullEquivalentFieldValue = findPostgresDefaultNullEquivalentValue(
    value,
    fieldMetadataType,
    subFieldKey,
  );

  const hasNullEquivalentFieldValue = isDefined(nullEquivalentFieldValue);

  switch (operator) {
    case 'isEmptyArray':
      return {
        sql: `${fieldReference} = '{}'${hasNullEquivalentFieldValue ? ` OR ${fieldReference} IS NULL` : ''}`,
        params: {},
      };
    case 'eq':
      if (isDateTimeField) {
        return {
          sql: `(${fieldReference} >= :${key}${paramSuffix} AND ${fieldReference} < :${key}${paramSuffix}::timestamptz + interval '1 millisecond')${hasNullEquivalentFieldValue ? ` OR ${fieldReference} IS NULL` : ''}`,
          params: { [`${key}${paramSuffix}`]: value },
        };
      }

      return {
        sql: `${fieldReference} = :${key}${paramSuffix}${hasNullEquivalentFieldValue ? ` OR ${fieldReference} IS NULL` : ''}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'neq':
      if (isDateTimeField) {
        return {
          sql: `(${fieldReference} < :${key}${paramSuffix} OR ${fieldReference} >= :${key}${paramSuffix}::timestamptz + interval '1 millisecond')${hasNullEquivalentFieldValue ? ` AND ${fieldReference} IS NOT NULL` : ''}`,
          params: { [`${key}${paramSuffix}`]: value },
        };
      }

      return {
        sql: `${fieldReference} != :${key}${paramSuffix}${hasNullEquivalentFieldValue ? ` AND ${fieldReference} IS NOT NULL` : ''}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'gt':
      if (isDateTimeField) {
        return {
          sql: `${fieldReference} >= :${key}${paramSuffix}::timestamptz + interval '1 millisecond'`,
          params: { [`${key}${paramSuffix}`]: value },
        };
      }

      return {
        sql: `${fieldReference} > :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'gte':
      return {
        sql: `${fieldReference} >= :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'lt':
      return {
        sql: `${fieldReference} < :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'lte':
      if (isDateTimeField) {
        return {
          sql: `${fieldReference} < :${key}${paramSuffix}::timestamptz + interval '1 millisecond'`,
          params: { [`${key}${paramSuffix}`]: value },
        };
      }

      return {
        sql: `${fieldReference} <= :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'in':
      return {
        sql: `${fieldReference} IN (:...${key}${paramSuffix})`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'is':
      return {
        sql: `${fieldReference} IS ${value === 'NULL' ? 'NULL' : 'NOT NULL'}${hasNullEquivalentFieldValue ? ` OR ${fieldReference} = :${key}${secondParamSuffix}` : ''}`,
        params: hasNullEquivalentFieldValue
          ? { [`${key}${secondParamSuffix}`]: nullEquivalentFieldValue }
          : {},
      };
    // Keyset cursors must mirror SQL scan order, where only real NULLs sort into the NULL block, so the
    // empty-value widening of 'is' and 'eq' would skip or duplicate rows at the block boundaries
    case 'isStrictly':
      return {
        sql: `${fieldReference} IS ${value === 'NULL' ? 'NULL' : 'NOT NULL'}`,
        params: {},
      };
    case 'eqStrict':
      if (isDateTimeField) {
        return {
          sql: `(${fieldReference} >= :${key}${paramSuffix} AND ${fieldReference} < :${key}${paramSuffix}::timestamptz + interval '1 millisecond')`,
          params: { [`${key}${paramSuffix}`]: value },
        };
      }

      return {
        sql: `${fieldReference} = :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'like':
      return {
        sql: `${fieldReference}::text LIKE :${key}${paramSuffix}${hasNullEquivalentFieldValue ? ` OR ${fieldReference} IS NULL` : ''}`,
        params: { [`${key}${paramSuffix}`]: `${value}` },
      };
    case 'ilike':
      return {
        sql: `${fieldReference}::text ILIKE :${key}${paramSuffix}${hasNullEquivalentFieldValue ? ` OR ${fieldReference} IS NULL` : ''}`,
        params: { [`${key}${paramSuffix}`]: `${value}` },
      };
    case 'startsWith':
      return {
        sql: `${fieldReference}::text ^@ :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: `${value}` },
      };
    case 'endsWith':
      return {
        sql: `RIGHT(${fieldReference}::text, LENGTH(:${key}${paramSuffix})) = :${key}${paramSuffix}`,
        params: { [`${key}${paramSuffix}`]: `${value}` },
      };
    case 'contains':
      return {
        sql: `${fieldReference} @> ARRAY[:...${key}${paramSuffix}]`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'search': {
      const tsQuery = formatSearchTerms(value, 'and');

      return {
        sql: `(
          ${fieldReference} @@ to_tsquery('simple', public.unaccent_immutable(:${key}${paramSuffix}Ts)) OR
          public.unaccent_immutable(${fieldReference}::text) ILIKE public.unaccent_immutable(:${key}${paramSuffix}Like)
        )`,
        params: {
          [`${key}${paramSuffix}Ts`]: tsQuery,
          [`${key}${paramSuffix}Like`]: `%${value}%`,
        },
      };
    }
    case 'notContains':
      return {
        sql: `NOT (${fieldReference}::text[] && ARRAY[:...${key}${paramSuffix}]::text[])`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'containsAny':
      return {
        sql: `${fieldReference}::text[] && ARRAY[:...${key}${paramSuffix}]::text[]`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    case 'containsIlike':
      return {
        sql: `EXISTS (SELECT 1 FROM unnest(${fieldReference}) AS elem WHERE elem ILIKE :${key}${paramSuffix})`,
        params: { [`${key}${paramSuffix}`]: value },
      };
    default:
      throw new GraphqlQueryRunnerException(
        `Operator "${operator}" is not supported`,
        GraphqlQueryRunnerExceptionCode.UNSUPPORTED_OPERATOR,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
  }
};

export const computeWhereConditionParts = ({
  operator,
  objectNameSingular,
  key,
  subFieldKey,
  value,
  fieldMetadataType,
  useDirectTableReference = false,
  isNegated = false,
}: {
  operator: string;
  objectNameSingular: string;
  key: string;
  subFieldKey?: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  value: any;
  fieldMetadataType: FieldMetadataType;
  useDirectTableReference?: boolean;
  isNegated?: boolean;
}): WhereConditionParts => {
  const conditionParts = computeBaseWhereConditionParts({
    operator,
    objectNameSingular,
    key,
    subFieldKey,
    value,
    fieldMetadataType,
    useDirectTableReference,
  });

  // NOT (col = v) is UNKNOWN for NULL rows and drops them, while every other
  // in-memory matcher treats a NULL record as matching "is not <value>". Making
  // the negated predicate FALSE on NULL rows keeps NOT (...) true for them.
  if (isNegated && !NULL_INSENSITIVE_OPERATORS.has(operator)) {
    const fieldReference = useDirectTableReference
      ? `"${key}"`
      : `"${objectNameSingular}"."${key}"`;

    return {
      sql: `(${conditionParts.sql}) AND ${fieldReference} IS NOT NULL`,
      params: conditionParts.params,
    };
  }

  return conditionParts;
};

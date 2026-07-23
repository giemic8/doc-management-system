export type CustomFieldType = 'string' | 'number' | 'date' | 'boolean' | 'dropdown';

export interface CustomFieldDefinition {
  id: string;
  name: string;
  field_type: CustomFieldType;
  required?: boolean;
  options?: string[];
}

export interface ValidationError {
  fieldId: string;
  fieldName: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function isValidDate(value: any): boolean {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/**
 * Validates a set of submitted custom-field values against a document
 * type's schema: required fields must be present, and each present value
 * must match its declared type (string/number/date/boolean/dropdown).
 */
export function validateCustomFieldValues(
  schema: CustomFieldDefinition[],
  values: Record<string, any>
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const field of schema) {
    const value = values[field.id];
    const isPresent = value !== undefined && value !== null && value !== '';

    if (!isPresent) {
      if (field.required) {
        errors.push({ fieldId: field.id, fieldName: field.name, message: 'This field is required' });
      }
      continue;
    }

    switch (field.field_type) {
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push({ fieldId: field.id, fieldName: field.name, message: 'Must be a number' });
        }
        break;
      case 'date':
        if (!isValidDate(value)) {
          errors.push({ fieldId: field.id, fieldName: field.name, message: 'Must be a valid date' });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ fieldId: field.id, fieldName: field.name, message: 'Must be true or false' });
        }
        break;
      case 'dropdown':
        if (!field.options?.includes(value)) {
          errors.push({ fieldId: field.id, fieldName: field.name, message: `Must be one of: ${field.options?.join(', ')}` });
        }
        break;
      case 'string':
      default:
        if (typeof value !== 'string') {
          errors.push({ fieldId: field.id, fieldName: field.name, message: 'Must be text' });
        }
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

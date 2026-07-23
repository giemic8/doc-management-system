# Ticket #5: [Feature] Dynamic Custom Metadata Schemas by Document Type

## Type
`feature`, `metadata`

## Description
Different document categories require different metadata attributes. For example, Invoices need `IBAN` and `Tax Amount`; Contracts need `Notice Period` and `Renewal Date`; Car documents need `VIN` and `License Plate`.

## Acceptance Criteria
- [ ] Admin UI to define Metadata Schema templates bound to specific Document Types.
- [ ] Support field types: String, Number, Date, Boolean, Dropdown Select.
- [ ] Automatically render category-specific fields when a document type is selected.
- [ ] Validate required custom fields before archiving or marking as completed.

# MASTER_DEVELOPMENT_PROMPT_V1.0.md

# AI Content Operating System (AI-COS)

## Master Development Prompt

**Version:** 1.0\
**Status:** Planning

------------------------------------------------------------------------

# Objective

This document is the master instruction set for AI-assisted development
of AI-COS. Every implementation task must align with the project
blueprint, architecture, and design documents.

------------------------------------------------------------------------

# Development Rules

-   Build only from approved documentation.
-   Never introduce features outside the approved scope.
-   Preserve modular architecture.
-   Follow API-first principles.
-   Keep AI providers abstracted behind the provider layer.
-   Maintain workspace isolation.
-   Every feature must be testable.
-   Human approval is required before publishing workflows.

------------------------------------------------------------------------

# Required Inputs

Before implementing any module, load and follow:

1.  AI_CONTENT_OPERATING_SYSTEM_MASTER_BLUEPRINT_V1.0.md
2.  Functional Requirement Document
3.  Enterprise Architecture
4.  Database & Entity Design
5.  Module Design
6.  Role & Permission Matrix
7.  AI Agent Framework
8.  Knowledge Pack Engine
9.  Relevant engine specification
10. Deployment, Security and QA documents

------------------------------------------------------------------------

# Standard Implementation Workflow

``` text
Read Requirements
      ↓
Design Validation
      ↓
Database Changes
      ↓
Backend APIs
      ↓
Frontend UI
      ↓
Automated Tests
      ↓
Security Review
      ↓
Documentation Update
      ↓
Manual Review
```

------------------------------------------------------------------------

# Coding Standards

## Backend

-   NestJS
-   TypeScript
-   SOLID principles
-   DTO validation
-   Transaction safety
-   RBAC enforcement

## Frontend

-   Next.js
-   TypeScript
-   Reusable components
-   Responsive UI
-   Accessibility support

------------------------------------------------------------------------

# Mandatory Deliverables

For every completed module provide:

-   Summary
-   Files Added
-   Files Modified
-   Database Changes
-   API Endpoints
-   UI Screens
-   Test Coverage
-   Verification Evidence
-   Known Limitations
-   Rollback Notes (if applicable)

------------------------------------------------------------------------

# Quality Gates

-   Build passes
-   Lint passes
-   Typecheck passes
-   Unit tests pass
-   Integration tests pass
-   E2E tests pass
-   Security review complete
-   Documentation updated

------------------------------------------------------------------------

# Change Control

-   No breaking changes without approval
-   Version every document
-   Keep commits atomic
-   Maintain backward compatibility where possible

------------------------------------------------------------------------

# Out of Scope

-   Unapproved features
-   Hidden architectural changes
-   Direct provider coupling
-   Skipping tests
-   Skipping documentation

------------------------------------------------------------------------

# Success Criteria

Implementation is complete only when:

-   Functional requirements are satisfied
-   Quality gates pass
-   Documentation is updated
-   Review evidence is supplied
-   Module is ready for production validation

------------------------------------------------------------------------

# Next Document

`IMPLEMENTATION_CHECKLIST_V1.0.md`

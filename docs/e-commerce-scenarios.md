# E-Commerce Backend — Iterative Feature Development Scenarios

## Overview

Build an e-commerce backend in Java/Spring/JPA with Flyway migrations, iterating through features using the Lakebase SCM workflow. Each scenario simulates what a developer does day-to-day: create a branch, write code + migration, commit, push, open a PR, get it merged, and verify production.

## Architecture

```
src/main/java/com/example/demo/
├── DemoApplication.java
├── model/          # JPA entities
├── repository/     # Spring Data JPA repositories
├── service/        # Business logic
└── controller/     # REST endpoints

src/main/resources/db/migration/
├── V1__init_placeholder.sql     # From scaffold
├── V2-V9                        # One per scenario
```

---

## Master Execution Outline

Every scenario follows this execution outline. Scenario-specific details (branch name, migration SQL, Java files) are defined in each scenario section. The CI/CD pipeline steps are identical for all.

### Phase A: Developer (Local)

| Step | Action | Detail |
|------|--------|--------|
| A1 | **Create feature branch** | `git checkout -b {branch-name}` from main |
| | | post-checkout hook fires → creates Lakebase branch `{sanitized-branch-name}` |
| | | `.env` updated with branch database connection |
| A2 | **Write Java code** | JPA entities, repositories, services, controllers (scenario-specific) |
| A3 | **Write migration SQL** | `V{N}__{description}.sql` in `src/main/resources/db/migration/` |
| A4 | **Run tests locally** | `./mvnw test` |
| | | Spring Boot starts → Flyway applies migration to branch DB → Hibernate validates entities match → tests execute |
| A5 | **Commit** | `git add -A && git commit -m "{message}"` |
| | | prepare-commit-msg hook fires → schema diff appended to commit |
| A6 | **Push** | `git push -u origin {branch-name}` |
| | | pre-push hook fires → syncs GitHub secrets for CI |

### Phase B: CI/CD Pipeline — PR Workflow (pr.yml, self-hosted runner)

Triggered automatically when the PR is created or updated.

| Step | Action | Detail |
|------|--------|--------|
| B1 | **Checkout code** | `actions/checkout` with `fetch-depth: 0` |
| B2 | **Set up JDK** | Temurin JDK with Maven cache |
| B3 | **Install Databricks CLI** | If not already on runner PATH |
| B4 | **Create CI database branch** | Creates `ci-pr-{N}` Lakebase branch from default (production) branch |
| | | Resolves default branch UID from `list-branches` |
| | | Creates branch with `create-branch` (source = production) |
| | | Waits for READY state (polls up to 2 min) |
| | | Gets or creates primary endpoint, waits for ACTIVE |
| | | Generates database credential + resolves user email |
| | | Outputs JDBC URL, username, password |
| B5 | **Configure datasource** | Sets `SPRING_DATASOURCE_URL/USERNAME/PASSWORD` as env vars for subsequent steps |
| B6 | **Install PostgreSQL client** | For Flyway repair and schema diff (`psql`, `pg_dump`) |
| B7 | **Repair flyway_schema_history** | Removes bogus entries where migration version is recorded but table doesn't exist |
| B8 | **Flyway migrate (CI branch)** | `./mvnw flyway:migrate` against `ci-pr-{N}` database |
| | | Applies the new `V{N}` migration to the CI branch |
| B9 | **Flyway migrate (feature branch)** | Also applies migrations to the feature-named Lakebase branch |
| | | Creates feature Lakebase branch from `ci-pr-{N}` if needed |
| | | Keeps the developer's branch DB in sync with CI |
| B10 | **Run tests** | `./mvnw test` against CI branch database |
| | | Spring Boot starts → Flyway validates → Hibernate validates → all tests execute |
| B11 | **Schema diff (CI vs production)** | `pg_dump --schema-only` on both CI branch and production |
| | | `format-schema-diff.sh` produces human-readable diff |
| | | Shows CREATED/MODIFIED/REMOVED tables with columns |
| B12 | **Post PR comment** | ✅/❌ status + schema diff + workflow run link |
| B13 | **Notify tester queue** | Optional webhook for QA notification |

### Phase C: Merge + Production Deployment (merge.yml, self-hosted runner)

Triggered when the PR is merged to main.

| Step | Action | Detail |
|------|--------|--------|
| C1 | **Checkout code** | Full checkout of main (post-merge) |
| C2 | **Set up JDK + Databricks CLI** | Same as PR workflow |
| C3 | **Resolve production credentials** | Gets default (production) Lakebase branch endpoint + credential |
| C4 | **Flyway migrate (production)** | `./mvnw flyway:migrate` against production database |
| | | Applies `V{N}` migration to production |
| C5 | **Verify schema** | Queries `pg_tables` on production |
| | | Compares expected tables (from all `CREATE TABLE` in migrations) vs actual |
| | | **Fails the workflow** if any tables are missing |
| C6 | **Cleanup Lakebase branches** | Deletes `ci-pr-{N}` branch |
| | | Deletes feature-named Lakebase branch |

### Phase D: Post-Merge Verification

| Step | Action | Detail |
|------|--------|--------|
| D1 | **Verify flyway_schema_history** | `V{N}` exists in production `flyway_schema_history` with `success=true` |
| D2 | **Verify tables on production** | All tables created by the scenario exist (or are dropped, for Scenario 8) |
| D3 | **Verify CI branch cleanup** | `ci-pr-{N}` Lakebase branch no longer exists |
| D4 | **Verify feature branch cleanup** | Feature-named Lakebase branch no longer exists |
| D5 | **Verify main is up to date** | `git pull` on main shows the merge commit |

---

## Scenario 1: Book Entity (Initial Feature)

**Story:** Developer is tasked with adding a book catalog to the new e-commerce app.

**Branch:** `feature/book`
**Migration:** `V2__create_book_table.sql`

```sql
CREATE TABLE IF NOT EXISTS book (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255),
    price DECIMAL(19, 2),
    publish_date DATE
);
```

**Java files (Step A2):**
- `model/Book.java` — JPA entity (id, title, price, publishDate)
- `repository/BookRepository.java` — extends JpaRepository
- `service/BookService.java` — findAll, findById, save, delete
- `controller/BookController.java` — GET /books, POST /books, GET /books/{id}, DELETE /books/{id}

**Commit message (Step A5):** `"Add book entity with CRUD"`

**Post-merge verification (Phase D):**
- `book` table exists on production
- V2 in flyway_schema_history

**Follows:** Master Execution Outline (Phases A → B → C → D)

---

## Scenario 2: Product Catalog

**Story:** The business needs a product catalog with inventory tracking.

**Branch:** `feature/product-catalog`
**Migration:** `V3__create_product_table.sql`

```sql
CREATE TABLE IF NOT EXISTS product (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(19, 2) NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    category VARCHAR(100),
    image_url VARCHAR(512)
);
```

**Java files (Step A2):**
- `model/Product.java` — @Entity with NOT NULL, DEFAULT
- `repository/ProductRepository.java` — findByCategory, findByTitleContaining
- `service/ProductService.java` — CRUD + updateStock
- `controller/ProductController.java` — full REST API

**Commit message:** `"Add product catalog with inventory"`

**Post-merge verification:** `product` table on production, V3 applied

**Follows:** Master Execution Outline

---

## Scenario 3: Customer Registration

**Story:** Customers need to create accounts to shop.

**Branch:** `feature/customer`
**Migration:** `V4__create_customer_table.sql`

```sql
CREATE TABLE IF NOT EXISTS customer (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Java files (Step A2):**
- `model/Customer.java` — @Column(unique=true) on email
- `repository/CustomerRepository.java` — findByEmail
- `service/CustomerService.java` — register, findByEmail
- `controller/CustomerController.java` — POST /customers, GET /customers/{id}

**Commit message:** `"Add customer registration with email uniqueness"`

**Post-merge verification:** `customer` table with UNIQUE on email, V4 applied

**Follows:** Master Execution Outline

---

## Scenario 4: Shopping Cart

**Story:** Customers need to add products to a shopping cart before checkout.

**Branch:** `feature/cart`
**Migration:** `V5__create_cart_and_cart_item_tables.sql`

```sql
CREATE TABLE IF NOT EXISTS cart (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL UNIQUE REFERENCES customer(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_item (
    id BIGSERIAL PRIMARY KEY,
    cart_id BIGINT NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_cart_item_cart_id ON cart_item(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_item_product_id ON cart_item(product_id);
```

**Java files (Step A2):**
- `model/Cart.java` — @OneToOne with Customer
- `model/CartItem.java` — @ManyToOne to Cart + Product
- `repository/CartRepository.java` — findByCustomerId
- `repository/CartItemRepository.java`
- `service/CartService.java` — getOrCreateCart, addItem, removeItem, clearCart
- `controller/CartController.java` — GET /cart, POST /cart/items, DELETE /cart/items/{id}

**Commit message:** `"Add shopping cart with customer and product references"`

**Post-merge verification:** `cart` + `cart_item` tables with FKs, indexes, CHECK, V5 applied

**Follows:** Master Execution Outline

---

## Scenario 5: Order Processing

**Story:** Customers check out their cart to place orders. Stock must be validated.

**Branch:** `feature/orders`
**Migration:** `V6__create_orders_and_order_item_tables.sql`

```sql
CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_item (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price_at_order NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_item_order_id ON order_item(order_id);
```

**Java files (Step A2):**
- `model/Order.java` — @Enumerated for status
- `model/OrderItem.java` — price snapshot at order time
- `model/OrderStatus.java` — enum: PENDING, CONFIRMED, SHIPPED, DELIVERED, CANCELLED
- `repository/OrderRepository.java` — findByCustomerId
- `repository/OrderItemRepository.java`
- `service/OrderService.java` — placeOrder (validate stock, convert cart), updateStatus
- `service/InsufficientStockException.java`
- `controller/OrderController.java` — POST /orders, GET /orders/{id}, PATCH /orders/{id}/status

**Commit message:** `"Add order processing with stock validation"`

**Post-merge verification:** `orders` + `order_item` tables, V6 applied

**Follows:** Master Execution Outline

---

## Scenario 6: Wishlist

**Story:** Customers can save products for later and move them to cart.

**Branch:** `feature/wishlist`
**Migration:** `V7__create_wishlist_tables.sql`

```sql
CREATE TABLE IF NOT EXISTS wishlist (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL UNIQUE REFERENCES customer(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wishlist_item (
    id BIGSERIAL PRIMARY KEY,
    wishlist_id BIGINT NOT NULL REFERENCES wishlist(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wishlist_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_item_wishlist_id ON wishlist_item(wishlist_id);
```

**Java files (Step A2):**
- `model/Wishlist.java` — @OneToOne Customer
- `model/WishlistItem.java` — compound UNIQUE
- `repository/WishlistRepository.java` — findByCustomerId
- `repository/WishlistItemRepository.java`
- `service/WishlistService.java` — add, remove, moveToCart
- `controller/WishlistController.java` — GET /wishlist, POST /wishlist/items, POST /wishlist/items/{id}/move-to-cart

**Commit message:** `"Add wishlist with move-to-cart functionality"`

**Post-merge verification:** `wishlist` + `wishlist_item` tables, compound UNIQUE, V7 applied

**Follows:** Master Execution Outline

---

## Scenario 7: Schema Evolution — ALTER TABLE

**Story:** Product reviews feature needs rating columns on the product table.

**Branch:** `feature/product-reviews`
**Migration:** `V8__add_product_rating_and_review_count.sql`

```sql
ALTER TABLE product ADD COLUMN average_rating DECIMAL(3, 2) DEFAULT 0.00;
ALTER TABLE product ADD COLUMN review_count INTEGER DEFAULT 0;
```

**Java update (Step A2):** Modify `model/Product.java` — add `averageRating` and `reviewCount` fields

**Note:** No new files — only modifying one existing Java file + adding migration. This tests ALTER TABLE (no CREATE).

**Commit message:** `"Add product rating and review count columns"`

**Post-merge verification:** `average_rating` and `review_count` columns exist on `product` table, V8 applied. Schema diff shows MODIFIED (not CREATED).

**Follows:** Master Execution Outline

---

## Scenario 8: Schema Evolution — DROP TABLE (Remove Book)

**Story:** Business pivot — books are discontinued. Remove the book entity entirely.

**Branch:** `feature/remove-book`
**Migration:** `V9__drop_book_table.sql`

```sql
DROP TABLE IF EXISTS book;
```

**Java deletions (Step A2):**
- Delete `model/Book.java`
- Delete `repository/BookRepository.java`
- Delete `service/BookService.java`
- Delete `controller/BookController.java`

**Note:** Git diff shows 1 file added (migration), 4 files deleted (Java). Tests DROP TABLE and entity removal.

**Commit message:** `"Remove book entity — discontinued product line"`

**Post-merge verification:**
- `book` table does **NOT** exist on production
- V9 applied in flyway_schema_history
- Book Java files absent from repo
- All other tables still exist (no collateral damage)

**Follows:** Master Execution Outline

---

## Test Implementation

### File Structure

```
test/integration/ecommerce/
├── helpers.ts                    # Shared helper functions (no tests)
├── runner.ts                     # Ephemeral self-hosted GitHub Actions runner lifecycle
├── mavenProject.ts               # Maven/Spring Boot project scaffolding
├── ecommerceScenarios.test.ts    # Top-level Mocha orchestrator
├── scenario1_6_AllEntities.ts    # Scenarios 1-6 combined: all entities in one branch/PR/merge
├── scenario1Book.ts              # Book entity data (exports migrations, Java files, tests)
├── scenario2Product.ts           # Product entity data
├── scenario3Customer.ts          # Customer entity data
├── scenario4Cart.ts              # Cart entity data
├── scenario5Orders.ts            # Orders entity data
├── scenario6Wishlist.ts          # Wishlist entity data
├── scenario7AlterProduct.ts      # Scenario 7: ALTER TABLE product (ADD COLUMN)
└── scenario8DropBook.ts          # Scenario 8: DROP TABLE book
```

### How to Run

All tests run through the existing Mocha integration test harness defined in `package.json`:

```bash
# Run all e-commerce scenarios (full suite — 3 scenarios)
npm run test:integration -- --grep "E-Commerce"

# Run all integration suites in parallel (e-commerce, python, runner)
./test/integration/run-all.sh

# Run a single suite
./test/integration/run-all.sh java

# Run with verbose output
npm run test:integration -- --grep "E-Commerce" --reporter spec
```

The underlying npm script is:
```
TS_NODE_TRANSPILE_ONLY=1 mocha \
  --require test/setup.js \
  --require ts-node/register \
  'test/integration/**/*.test.ts' \
  --timeout 120000
```

Key flags:
- `TS_NODE_TRANSPILE_ONLY=1` — avoids Node 22 ESM resolution conflicts with the `vscode` mock
- `test/setup.js` — sets up the `vscode` module mock before any imports
- `--timeout 120000` — 2 min default per test (individual tests override with `this.timeout()`)

### Prerequisites

Before running, ensure:
1. **GitHub CLI** authenticated: `gh auth status`
2. **Databricks CLI** authenticated: `databricks auth login --host <host>`
3. **psql** installed: `psql --version` (used for production database queries in Phase D)
4. **Java 21+** installed: `java -version` (the self-hosted runner needs JDK for Maven/Flyway)
5. **DATABRICKS_HOST** set in env or defaults to the stable FEVM host
6. **gh delete_repo scope**: `gh auth refresh -s delete_repo` (needed for teardown)
7. **Internet access** for downloading: GitHub Actions runner binary (~100MB, cached in `~/.cache/github-actions-runner/`), Maven wrapper + dependencies (first run)

### Architecture

#### runner.ts — Ephemeral Self-Hosted Runner

Manages the lifecycle of a GitHub Actions runner that executes pr.yml and merge.yml workflows:

- `ensureRunnerBinary()` — Downloads the runner archive to `~/.cache/github-actions-runner/` (cached across runs), extracts to a unique temp dir.
- `startRunner(ctx, runnerDir)` — Gets a registration token via `gh api`, configures the runner (non-ephemeral, since we need it for 16+ jobs), starts `./run.sh` in background, polls until the runner appears online.
- Returns `RunnerHandle` with `cleanup(ctx)` — kills process, deregisters runner via API, removes temp dir.

Runner binary: `actions-runner-osx-arm64-{version}.tar.gz` (auto-detects platform).

#### mavenProject.ts — Maven/Spring Boot Scaffolding

`scaffoldMavenProject(projectDir)` writes a minimal but real Maven project so `./mvnw flyway:migrate` and `./mvnw test` work in the CI workflows:

- **pom.xml** — Spring Boot 3.5.5, JPA, Flyway 10.22.0, PostgreSQL driver, Flyway Maven plugin with `baselineOnMigrate`
- **mvnw** — Downloaded from Apache Maven Wrapper repo
- **.mvn/wrapper/maven-wrapper.properties** — Maven 3.9.9
- **DemoApplication.java** — `@SpringBootApplication` main class
- **application.properties** — datasource from env vars, `ddl-auto=validate`, flyway enabled
- **DemoApplicationTests.java** — minimal `contextLoads()` test

#### helpers.ts — Shared Functions

No test code. Exports functions consumed by all 8 scenario files:

| Category | Functions | Purpose |
|----------|-----------|---------|
| **Shell** | `git(ctx, cmd)`, `shell(ctx, cmd)`, `dbcli(ctx, args)` | Run git/shell/databricks commands |
| **Phase A** | `createFeatureBranch`, `writeJavaFile`, `deleteJavaFile`, `writeMigration`, `commitAndPush` | Developer local workflow |
| **Phase B/C** | `createPR`, `mergePR`, `pullMain`, `cleanupBranch` | PR lifecycle via `gh` CLI |
| **Workflow** | `waitForWorkflowRun`, `getLatestRunId`, `getWorkflowLogs` | Poll `gh run list` until workflow completes; fetch logs on failure |
| **Phase D** | `queryProduction`, `verifyTableExists`, `verifyTableNotExists`, `verifyColumnExists`, `verifyMigrationApplied` | SQL queries against production via `psql` (using `databricks` CLI for credentials) |
| **GitHub** | `verifyFileOnGitHub`, `verifyFileNotOnGitHub` | Check file presence via `gh api` |
| **Schema** | `parseMigrationSql` | Delegates to `SchemaMigrationService.parseSql()` |
| **Cleanup** | `deleteLakebaseBranch` | Non-fatal branch deletion via `databricks` CLI |

All functions take a `ScenarioContext` as first argument — a shared object containing project name, directory, GitHub user, Lakebase host, and service instances.

#### scenarioN*.ts — Scenario Files

Each scenario file exports a single function:
```typescript
export function runScenario(ctx: ScenarioContext): void
```

This function registers Mocha `describe`/`it` blocks. Scenarios 1-6 are consolidated into `scenario1_6_AllEntities.ts`, which imports entity data (migrations, Java files, tests) from the individual `scenario1Book.ts`–`scenario6Wishlist.ts` files. Scenarios 7 and 8 remain standalone. Each follows the Master Execution Outline with 4 describe blocks:

```
describe('Phase A: Developer')
  it('A1: creates feature branch')
  it('A2: writes Java files')
  it('A3: writes migration SQL')
  it('A5+A6: commits and pushes')

describe('Phase B: PR workflow')
  it('B1: creates PR')
  it('B2: pr.yml succeeds (Flyway + tests on branch DB)')

describe('Phase C: Merge workflow')
  it('C1: records latest merge.yml run ID')
  it('C2: merges PR')
  it('C3: merge.yml succeeds (Flyway on production)')
  it('C4: pulls main')

describe('Phase D: Verification')
  it('D1: migration version in flyway_schema_history')
  it('D2: table(s) exist on production')
  it('D3: files visible on GitHub')
  it('D4: cleanup feature branch + Lakebase branch')
```

The runner handles all Flyway/Lakebase operations via the actual CI workflows. Tests just wait for workflows to complete and verify the result.

#### ecommerceScenarios.test.ts — Orchestrator

The single `.test.ts` file that Mocha discovers. Structure:

```
describe('E-Commerce Backend — 8 Iterative Scenarios')
  before()
    → ProjectCreationService.createProject()
    → scaffoldMavenProject()   ← pom.xml, mvnw, DemoApplication.java
    → git commit + push Maven files
    → ensureRunnerBinary()     ← download/cache runner binary
    → startRunner()            ← configure + start self-hosted runner

  describe('Scenarios 1-6: All Entities')     → scenario1_6(ctx)
  describe('Scenario 7: ALTER TABLE')         → scenario7(ctx)
  describe('Scenario 8: DROP TABLE')          → scenario8(ctx)

  describe('Final Verification')
    it('8 migrations applied (V2-V9)')
    it('book table does NOT exist')
    it('all 8 remaining tables exist')
    it('flyway_schema_history has 9 entries')
    it('3 merge commits on main (scenarios 1-6, 7, 8)')
    it('Book Java files absent')
    it('all other Java files present')

  describe('Teardown')
    → runner.cleanup()         ← stop + deregister runner
    → cleanupProject()         ← delete GitHub repo + Lakebase project + local dir
  after()                      → safety-net cleanup
```

**Sequencing:** Scenarios 1-6 run as a single combined branch/PR/merge cycle (all 6 entities created together). Scenario 7 (ALTER TABLE) and Scenario 8 (DROP TABLE) follow as separate cycles.

**Timeouts:** 2 hours overall, 10 min per scenario, 7 min for workflow wait, 1 min for verification.

**Skip logic:** If `before()` fails (project creation or runner setup), all scenarios are skipped via `if (!created) { this.skip(); }`. Teardown still runs via the `after()` safety net.

### Test Count

| Section | Tests |
|---------|-------|
| Scenarios 1-6 (All Entities) | 19 |
| Scenario 7 (ALTER) | 21 |
| Scenario 8 (DROP) | 22 |
| Final Verification + Teardown | 8 |
| **Total** | **70** |

### What Each Test Exercises

| Test Point | What Happens |
|------------|-------------|
| A3-verify (parseSql) | `SchemaMigrationService.parseSql()` — static SQL parser |
| B1 (create PR) | `gh pr create` via helpers |
| B2 (pr.yml succeeds) | Self-hosted runner executes pr.yml: Lakebase branch creation, Flyway migrate on branch, `./mvnw test`, schema diff, PR comment |
| C2 (merge PR) | `gh pr merge --admin` via helpers |
| C3 (merge.yml succeeds) | Self-hosted runner executes merge.yml: Flyway migrate on production, schema verification, Lakebase branch cleanup |
| D1 (migration applied) | `psql` query against `flyway_schema_history` on production |
| D2 (table exists) | `psql` query against `pg_tables` / `information_schema.columns` on production |
| D3 (files on GitHub) | `gh api repos/.../contents/...` |
| Setup | `ProjectCreationService.createProject()` + `scaffoldMavenProject()` + `startRunner()` |
| Teardown | `runner.cleanup()` + `ProjectCreationService.cleanupProject()` |

### Resources Created and Destroyed

Each test run creates and tears down:
- **1 GitHub repo** (private): `{user}/ecom-{timestamp}`
- **1 Lakebase project**: `ecom-{timestamp}`
- **1 self-hosted runner**: registered to the repo, running on local machine
- **3 Lakebase CI branches** (created by pr.yml, deleted by merge.yml)
- **3 Lakebase feature branches** (created by pr.yml, deleted by merge.yml)
- **3 GitHub PRs** (created and merged: scenarios 1-6 combined, 7, 8)
- **1 local directory** in `$TMPDIR`
- **1 runner directory** in `$TMPDIR`

All resources are cleaned up in teardown, with a safety-net `after()` hook that runs even if tests fail. The runner binary is cached in `~/.cache/github-actions-runner/` and reused across runs.

---

## Final State After All 8 Scenarios

### Tables on production (8 migrations applied, V2-V9):
- ~~book~~ (created in V2, dropped in V9)
- product (V3, altered in V8: +average_rating, +review_count)
- customer (V4)
- cart (V5), cart_item (V5)
- orders (V6), order_item (V6)
- wishlist (V7), wishlist_item (V7)

### Java files (book stack removed in Scenario 8):
- **Models (9):** Product, Customer, Cart, CartItem, Order, OrderItem, OrderStatus, Wishlist, WishlistItem
- **Repositories (8):** Product, Customer, Cart, CartItem, Order, OrderItem, Wishlist, WishlistItem
- **Services (5+):** Product, Customer, Cart, Order (+InsufficientStockException), Wishlist
- **Controllers (5):** Product, Customer, Cart, Order, Wishlist

### Git history:
3 merge commits (scenarios 1-6 combined, 7, 8), each with a PR number.

---

## Teardown

- Delete GitHub repo (`gh repo delete`)
- Delete Lakebase project (`databricks postgres delete-project`)
- Remove local project directory

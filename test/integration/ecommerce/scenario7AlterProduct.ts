/**
 * Scenario 7: Schema Evolution — ALTER TABLE
 *
 * Product reviews feature needs rating columns on the product table.
 * Tests: ALTER TABLE ADD COLUMN (no new tables), modifying existing entity.
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ScenarioContext, git, createFeatureBranch, writeJavaFile, writeMigration,
  commitAndPush, createPR, mergePR, pullMain, cleanupBranch,
  waitForWorkflowRun, getLatestRunId, getWorkflowLogs, getPRComments,
  verifyColumnExists, verifyMigrationApplied,
  parseMigrationSql, deleteLakebaseBranch,
  verifyBranchConnection, createLakebaseBranchAndConnect, writeJavaTestFile, deleteJavaTestFile, runMavenTests,
  setCurrentScenario, waitForRunnerIdle,
} from './helpers';

const BRANCH = 'feature/product-reviews';
const MIGRATION_FILE = 'V8__add_product_rating_and_review_count.sql';
const MIGRATION_SQL = `ALTER TABLE product ADD COLUMN average_rating DECIMAL(3, 2) DEFAULT 0.00;
ALTER TABLE product ADD COLUMN review_count INTEGER DEFAULT 0;
`;

const TEST_FILES: Record<string, string> = {
  'ProductReviewFieldsTest.java': `package com.example.demo;

import com.example.demo.model.Product;
import com.example.demo.service.ProductService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

import java.math.BigDecimal;

@SpringBootTest
@Transactional
class ProductReviewFieldsTest {
    @Autowired private ProductService productService;

    private Product createProduct() {
        Product p = new Product();
        p.setTitle("Rated"); p.setPrice(new BigDecimal("25.00")); p.setStock(5);
        return productService.save(p);
    }

    @Test
    void givenProduct_whenSetAverageRating_thenPersisted() {
        // Given
        Product product = createProduct();
        // When
        product.setAverageRating(new BigDecimal("4.50"));
        Product saved = productService.save(product);
        // Then
        Product found = productService.findById(saved.getId()).orElseThrow();
        assertEquals(new BigDecimal("4.50"), found.getAverageRating());
    }

    @Test
    void givenProduct_whenSetReviewCount_thenPersisted() {
        // Given
        Product product = createProduct();
        // When
        product.setReviewCount(42);
        Product saved = productService.save(product);
        // Then
        Product found = productService.findById(saved.getId()).orElseThrow();
        assertEquals(42, found.getReviewCount());
    }
}
`,
};

// Updated Product.java with the two new fields
const UPDATED_PRODUCT = `package com.example.demo.model;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "product")
public class Product {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false)
    private String title;
    private String description;
    @Column(nullable = false)
    private BigDecimal price;
    @Column(nullable = false)
    private Integer stock = 0;
    private String category;
    private String imageUrl;
    private BigDecimal averageRating = BigDecimal.ZERO;
    private Integer reviewCount = 0;

    public Product() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }
    public Integer getStock() { return stock; }
    public void setStock(Integer stock) { this.stock = stock; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getImageUrl() { return imageUrl; }
    public void setImageUrl(String imageUrl) { this.imageUrl = imageUrl; }
    public BigDecimal getAverageRating() { return averageRating; }
    public void setAverageRating(BigDecimal averageRating) { this.averageRating = averageRating; }
    public Integer getReviewCount() { return reviewCount; }
    public void setReviewCount(Integer reviewCount) { this.reviewCount = reviewCount; }
}
`;

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(7); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/product-reviews branch', () => {
      createFeatureBranch(ctx, BRANCH);
      const current = git(ctx, 'rev-parse --abbrev-ref HEAD');
      assert.strictEqual(current, BRANCH);
    });

    it('A1b: creates Lakebase branch via LakebaseService', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId, 'Lakebase branch ID should be set');
      assert.ok(conn.host, 'Endpoint host should be set');
      assert.ok(conn.username, 'Username should be set');
    });

    it('A1-verify: .env connected to Lakebase branch', () => {
      const conn = verifyBranchConnection(ctx);
      assert.ok(conn.url.includes('jdbc:postgresql://'), 'SPRING_DATASOURCE_URL should be a JDBC URL');
      assert.ok(conn.username, 'SPRING_DATASOURCE_USERNAME should be set');
    });

    it('A2: updates Product.java with rating fields', () => {
      writeJavaFile(ctx, 'model/Product.java', UPDATED_PRODUCT);
      const content = fs.readFileSync(
        path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', 'model', 'Product.java'),
        'utf-8'
      );
      assert.ok(content.includes('averageRating'));
      assert.ok(content.includes('reviewCount'));
    });

    it('A3: writes V8 migration SQL (ALTER TABLE)', () => {
      writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL);
    });

    it('A3-verify: parseSql extracts 2 ALTER TABLE changes on product', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      assert.strictEqual(changes.length, 2);
      assert.ok(changes.every(c => c.type === 'modified'));
      assert.ok(changes.every(c => c.tableName === 'product'));
      assert.ok(changes.some(c => c.columns[0].name === 'average_rating'));
      assert.ok(changes.some(c => c.columns[0].name === 'review_count'));
    });

    it('A4: writes given/when/then test files', () => {
      for (const [relPath, content] of Object.entries(TEST_FILES)) {
        writeJavaTestFile(ctx, relPath, content);
      }
    });

    it('A5: ./mvnw test passes against Lakebase branch DB', function () {
      this.timeout(300000);
      runMavenTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Add product rating and review count columns', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add product rating and review count columns', BRANCH);
      assert.ok(prNumber > 0, `PR number should be positive, got ${prNumber}`);
    });

    it('B2: pr.yml succeeds (Flyway + tests on branch DB)', () => {
      const result = waitForWorkflowRun(ctx, 'pr.yml', { branch: BRANCH, event: 'pull_request' });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`pr.yml failed (${result.conclusion}). Run ${result.runId}. Logs:\n${logs}`);
      }
    });

    it('B3: PR comment contains schema diff', () => {
      const comments = getPRComments(ctx, prNumber);
      assert.ok(comments.length > 0, 'PR should have at least one comment');
      const schemaDiffComment = comments.find(c =>
        c.body.includes('product') &&
        (c.body.includes('average_rating') || c.body.includes('MODIFIED') || c.body.includes('ALTER'))
      );
      assert.ok(schemaDiffComment, 'PR comment should mention product table with ALTER/MODIFIED/average_rating');
    });
  });

  describe('Phase C: Merge workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    let beforeMergeRunId: number;

    it('C1: records latest merge.yml run ID', () => {
      beforeMergeRunId = getLatestRunId(ctx, 'merge.yml');
    });

    it('C2: merges PR', () => {
      mergePR(ctx, prNumber);
    });

    it('C3: merge.yml succeeds (Flyway on production)', () => {
      const result = waitForWorkflowRun(ctx, 'merge.yml', { branch: 'main', event: 'push', afterRunId: beforeMergeRunId });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`merge.yml failed (${result.conclusion}). Run ${result.runId}. Logs:\n${logs}`);
      }
    });

    it('C4: pulls main', () => {
      pullMain(ctx);
    });
  });

  describe('Phase D: Verification', function () {
    this.timeout(60000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    it('D1: V8 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '8')); });
    it('D2: average_rating column exists on product', async () => {
      assert.ok(await verifyColumnExists(ctx, 'product', 'average_rating'));
    });
    it('D2: review_count column exists on product', async () => {
      assert.ok(await verifyColumnExists(ctx, 'product', 'review_count'));
    });
    it('D4: cleanup', async () => {
      cleanupBranch(ctx, BRANCH);
      await deleteLakebaseBranch(ctx, BRANCH);
    });

    it('D5: wait for runner idle', function () {
      this.timeout(300000);
      waitForRunnerIdle(ctx);
    });
  });
}

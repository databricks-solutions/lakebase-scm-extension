/**
 * Scenario 2: Product Catalog
 *
 * Business needs a product catalog with inventory tracking.
 * Tests: CREATE TABLE with NOT NULL, DEFAULT, custom repository methods.
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writeJavaFile, writeMigration,
  commitAndPush, createPR, mergePR, pullMain, cleanupBranch,
  waitForWorkflowRun, getLatestRunId, getWorkflowLogs, getPRComments,
  verifyTableExists, verifyMigrationApplied, verifyFileOnGitHub,
  parseMigrationSql, deleteLakebaseBranch,
  verifyBranchConnection, createLakebaseBranchAndConnect, writeJavaTestFile, deleteJavaTestFile, runMavenTests,
  setCurrentScenario, waitForRunnerIdle,
} from './helpers';

const BRANCH = 'feature/product-catalog';
export const MIGRATION_FILE = 'V3__create_product_table.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS product (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(19, 2) NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    category VARCHAR(100),
    image_url VARCHAR(512)
);
`;

export const TEST_FILES: Record<string, string> = {
  'ProductServiceTest.java': `package com.example.demo;

import com.example.demo.model.Product;
import com.example.demo.service.ProductService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

import java.math.BigDecimal;
import java.util.List;

@SpringBootTest
@Transactional
class ProductServiceTest {
    @Autowired private ProductService productService;

    @Test
    void givenProduct_whenSaved_thenCanBeRetrieved() {
        // Given
        Product product = new Product();
        product.setTitle("Widget");
        product.setPrice(new BigDecimal("9.99"));
        product.setStock(10);
        product.setCategory("gadgets");
        // When
        Product saved = productService.save(product);
        // Then
        assertTrue(productService.findById(saved.getId()).isPresent());
        assertEquals("Widget", productService.findById(saved.getId()).get().getTitle());
    }

    @Test
    void givenProducts_whenFindByCategory_thenFiltered() {
        // Given
        Product p1 = new Product();
        p1.setTitle("A"); p1.setPrice(BigDecimal.ONE); p1.setStock(1); p1.setCategory("books");
        Product p2 = new Product();
        p2.setTitle("B"); p2.setPrice(BigDecimal.ONE); p2.setStock(1); p2.setCategory("toys");
        productService.save(p1);
        productService.save(p2);
        // When
        List<Product> books = productService.findByCategory("books");
        // Then
        assertTrue(books.stream().allMatch(p -> "books".equals(p.getCategory())));
    }

    @Test
    void givenProduct_whenUpdateStock_thenStockChanged() {
        // Given
        Product product = new Product();
        product.setTitle("Stocked"); product.setPrice(BigDecimal.TEN); product.setStock(5);
        Product saved = productService.save(product);
        // When
        productService.updateStock(saved.getId(), 3);
        // Then
        assertEquals(8, productService.findById(saved.getId()).get().getStock());
    }
}
`,
  'ProductControllerTest.java': `package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ProductControllerTest {
    @Autowired private MockMvc mockMvc;

    @Test
    void givenProductPayload_whenPostProducts_thenCreated() throws Exception {
        // Given
        String json = "{\\"title\\":\\"Widget\\",\\"price\\":9.99,\\"stock\\":10,\\"category\\":\\"gadgets\\"}";
        // When / Then
        mockMvc.perform(post("/products").contentType(MediaType.APPLICATION_JSON).content(json))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.title").value("Widget"));
    }

    @Test
    void givenCategory_whenGetByCategory_thenFiltered() throws Exception {
        // Given
        String json = "{\\"title\\":\\"CatItem\\",\\"price\\":5.00,\\"stock\\":1,\\"category\\":\\"electronics\\"}";
        mockMvc.perform(post("/products").contentType(MediaType.APPLICATION_JSON).content(json));
        // When / Then
        mockMvc.perform(get("/products/category/electronics"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$").isArray());
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/Product.java': `package com.example.demo.model;

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
}
`,
  'repository/ProductRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Product;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface ProductRepository extends JpaRepository<Product, Long> {
    List<Product> findByCategory(String category);
    List<Product> findByTitleContaining(String keyword);
}
`,
  'service/ProductService.java': `package com.example.demo.service;

import com.example.demo.model.Product;
import com.example.demo.repository.ProductRepository;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.Optional;

@Service
public class ProductService {
    private final ProductRepository repo;
    public ProductService(ProductRepository repo) { this.repo = repo; }
    public List<Product> findAll() { return repo.findAll(); }
    public Optional<Product> findById(Long id) { return repo.findById(id); }
    public Product save(Product product) { return repo.save(product); }
    public void delete(Long id) { repo.deleteById(id); }
    public List<Product> findByCategory(String category) { return repo.findByCategory(category); }
    public void updateStock(Long id, int delta) {
        Product p = repo.findById(id).orElseThrow();
        p.setStock(p.getStock() + delta);
        repo.save(p);
    }
}
`,
  'controller/ProductController.java': `package com.example.demo.controller;

import com.example.demo.model.Product;
import com.example.demo.service.ProductService;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/products")
public class ProductController {
    private final ProductService service;
    public ProductController(ProductService service) { this.service = service; }

    @GetMapping
    public List<Product> list() { return service.findAll(); }

    @GetMapping("/{id}")
    public Product get(@PathVariable Long id) { return service.findById(id).orElseThrow(); }

    @PostMapping
    public Product create(@RequestBody Product product) { return service.save(product); }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) { service.delete(id); }

    @GetMapping("/category/{category}")
    public List<Product> byCategory(@PathVariable String category) { return service.findByCategory(category); }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(2); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/product-catalog branch', () => {
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

    it('A2: writes Product Java files', () => {
      for (const [relPath, content] of Object.entries(JAVA_FILES)) {
        writeJavaFile(ctx, relPath, content);
      }
    });

    it('A3: writes V3 migration SQL', () => {
      writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL);
    });

    it('A3-verify: parseSql extracts CREATE TABLE product with constraints', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].tableName, 'product');
      assert.ok(changes[0].columns.some(c => c.name === 'stock'));
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
      commitAndPush(ctx, 'Add product catalog with inventory', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add product catalog with inventory', BRANCH);
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
      const schemaDiffComment = comments.find(c => c.body.includes('product'));
      assert.ok(schemaDiffComment, 'PR comment should mention product table');
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
    it('D1: V3 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '3')); });
    it('D2: product table exists', async () => { assert.ok(await verifyTableExists(ctx, 'product')); });
    it('D3: files on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Product.java'));
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

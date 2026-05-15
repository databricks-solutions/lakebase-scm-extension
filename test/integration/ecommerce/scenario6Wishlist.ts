/**
 * Scenario 6: Wishlist
 *
 * Customers save products for later and move them to cart.
 * Tests: Compound UNIQUE constraint, ON DELETE CASCADE on both FKs.
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

const BRANCH = 'feature/wishlist';
export const MIGRATION_FILE = 'V7__create_wishlist_tables.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS wishlist (
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
`;

export const TEST_FILES: Record<string, string> = {
  'WishlistServiceTest.java': `package com.example.demo;

import com.example.demo.model.Customer;
import com.example.demo.model.Product;
import com.example.demo.model.Wishlist;
import com.example.demo.model.WishlistItem;
import com.example.demo.service.WishlistService;
import com.example.demo.service.CustomerService;
import com.example.demo.service.ProductService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

import java.math.BigDecimal;

@SpringBootTest
@Transactional
class WishlistServiceTest {
    @Autowired private WishlistService wishlistService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    private Customer createCustomer(String email) {
        Customer c = new Customer();
        c.setEmail(email); c.setName("Test"); c.setPasswordHash("hash");
        return customerService.register(c);
    }

    private Product createProduct(String title) {
        Product p = new Product();
        p.setTitle(title); p.setPrice(new BigDecimal("14.99")); p.setStock(10);
        return productService.save(p);
    }

    @Test
    void givenCustomer_whenGetOrCreateWishlist_thenCreated() {
        // Given
        Customer customer = createCustomer("wish1@test.com");
        // When
        Wishlist wishlist = wishlistService.getOrCreate(customer);
        // Then
        assertNotNull(wishlist.getId());
        assertEquals(customer.getId(), wishlist.getCustomer().getId());
    }

    @Test
    void givenWishlist_whenAddItem_thenItemAdded() {
        // Given
        Customer customer = createCustomer("wish2@test.com");
        Product product = createProduct("WishProd");
        Wishlist wishlist = wishlistService.getOrCreate(customer);
        // When
        WishlistItem item = wishlistService.addItem(wishlist, product);
        // Then
        assertNotNull(item.getId());
        assertEquals(product.getId(), item.getProduct().getId());
    }

    @Test
    void givenWishlistItem_whenRemove_thenRemoved() {
        // Given
        Customer customer = createCustomer("wish3@test.com");
        Product product = createProduct("WishRemove");
        Wishlist wishlist = wishlistService.getOrCreate(customer);
        WishlistItem item = wishlistService.addItem(wishlist, product);
        Long itemId = item.getId();
        // When
        wishlistService.removeItem(itemId);
        // Then — no exception means success
    }
}
`,
  'WishlistControllerTest.java': `package com.example.demo;

import com.example.demo.model.Customer;
import com.example.demo.model.Product;
import com.example.demo.model.Wishlist;
import com.example.demo.model.WishlistItem;
import com.example.demo.service.WishlistService;
import com.example.demo.service.CustomerService;
import com.example.demo.service.ProductService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import java.math.BigDecimal;
import java.util.UUID;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class WishlistControllerTest {
    @Autowired private MockMvc mockMvc;
    @Autowired private WishlistService wishlistService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    @Test
    void givenWishlistItemId_whenDelete_thenSucceeds() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        Customer c = new Customer();
        c.setEmail("wishctrl-" + uid + "@test.com"); c.setName("Ctrl"); c.setPasswordHash("hash");
        c = customerService.register(c);
        Product p = new Product();
        p.setTitle("WishCtrlProd"); p.setPrice(new BigDecimal("7.00")); p.setStock(5);
        p = productService.save(p);
        Wishlist wishlist = wishlistService.getOrCreate(c);
        WishlistItem item = wishlistService.addItem(wishlist, p);
        // When / Then
        mockMvc.perform(delete("/wishlist/items/" + item.getId()))
            .andExpect(status().isOk());
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/Wishlist.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "wishlist")
public class Wishlist {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @OneToOne
    @JoinColumn(name = "customer_id", nullable = false, unique = true)
    private Customer customer;
    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    public Wishlist() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Customer getCustomer() { return customer; }
    public void setCustomer(Customer customer) { this.customer = customer; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }
}
`,
  'model/WishlistItem.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "wishlist_item", uniqueConstraints = @UniqueConstraint(columnNames = {"wishlist_id", "product_id"}))
public class WishlistItem {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne
    @JoinColumn(name = "wishlist_id", nullable = false)
    private Wishlist wishlist;
    @ManyToOne
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;
    @Column(nullable = false)
    private OffsetDateTime addedAt = OffsetDateTime.now();

    public WishlistItem() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Wishlist getWishlist() { return wishlist; }
    public void setWishlist(Wishlist wishlist) { this.wishlist = wishlist; }
    public Product getProduct() { return product; }
    public void setProduct(Product product) { this.product = product; }
    public OffsetDateTime getAddedAt() { return addedAt; }
    public void setAddedAt(OffsetDateTime addedAt) { this.addedAt = addedAt; }
}
`,
  'repository/WishlistRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Wishlist;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface WishlistRepository extends JpaRepository<Wishlist, Long> {
    Optional<Wishlist> findByCustomerId(Long customerId);
}
`,
  'repository/WishlistItemRepository.java': `package com.example.demo.repository;

import com.example.demo.model.WishlistItem;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WishlistItemRepository extends JpaRepository<WishlistItem, Long> {
}
`,
  'service/WishlistService.java': `package com.example.demo.service;

import com.example.demo.model.*;
import com.example.demo.repository.*;
import org.springframework.stereotype.Service;
import java.util.Optional;

@Service
public class WishlistService {
    private final WishlistRepository wishlistRepo;
    private final WishlistItemRepository itemRepo;
    public WishlistService(WishlistRepository wishlistRepo, WishlistItemRepository itemRepo) {
        this.wishlistRepo = wishlistRepo; this.itemRepo = itemRepo;
    }
    public Wishlist getOrCreate(Customer customer) {
        return wishlistRepo.findByCustomerId(customer.getId())
            .orElseGet(() -> { Wishlist w = new Wishlist(); w.setCustomer(customer); return wishlistRepo.save(w); });
    }
    public WishlistItem addItem(Wishlist wishlist, Product product) {
        WishlistItem item = new WishlistItem();
        item.setWishlist(wishlist); item.setProduct(product);
        return itemRepo.save(item);
    }
    public void removeItem(Long itemId) { itemRepo.deleteById(itemId); }
}
`,
  'controller/WishlistController.java': `package com.example.demo.controller;

import com.example.demo.service.WishlistService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/wishlist")
public class WishlistController {
    private final WishlistService service;
    public WishlistController(WishlistService service) { this.service = service; }

    @DeleteMapping("/items/{id}")
    public void removeItem(@PathVariable Long id) { service.removeItem(id); }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(6); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/wishlist branch', () => {
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
    it('A2: writes Wishlist Java files', () => {
      for (const [p, c] of Object.entries(JAVA_FILES)) { writeJavaFile(ctx, p, c); }
    });
    it('A3: writes V7 migration SQL', () => { writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL); });

    it('A3-verify: parseSql extracts wishlist + wishlist_item', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      const created = changes.filter(c => c.type === 'created');
      assert.strictEqual(created.length, 2);
      assert.ok(created.some(c => c.tableName === 'wishlist'));
      assert.ok(created.some(c => c.tableName === 'wishlist_item'));
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
      commitAndPush(ctx, 'Add wishlist with move-to-cart functionality', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add wishlist with move-to-cart', BRANCH);
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
      const schemaDiffComment = comments.find(c => c.body.includes('wishlist'));
      assert.ok(schemaDiffComment, 'PR comment should mention wishlist table');
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
    it('D1: V7 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '7')); });
    it('D2: wishlist table exists', async () => { assert.ok(await verifyTableExists(ctx, 'wishlist')); });
    it('D2: wishlist_item table exists', async () => { assert.ok(await verifyTableExists(ctx, 'wishlist_item')); });
    it('D3: files on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Wishlist.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/WishlistItem.java'));
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

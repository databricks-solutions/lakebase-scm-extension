/**
 * Scenario 4: Shopping Cart
 *
 * Customers add products to a shopping cart before checkout.
 * Tests: Multiple CREATE TABLEs in one migration, FOREIGN KEYs, CHECK constraint, indexes.
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

const BRANCH = 'feature/cart';
export const MIGRATION_FILE = 'V5__create_cart_and_cart_item_tables.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS cart (
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
`;

export const TEST_FILES: Record<string, string> = {
  'CartServiceTest.java': `package com.example.demo;

import com.example.demo.model.Cart;
import com.example.demo.model.CartItem;
import com.example.demo.model.Customer;
import com.example.demo.model.Product;
import com.example.demo.service.CartService;
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
class CartServiceTest {
    @Autowired private CartService cartService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    private Customer createCustomer(String email) {
        Customer c = new Customer();
        c.setEmail(email); c.setName("Test"); c.setPasswordHash("hash");
        return customerService.register(c);
    }

    private Product createProduct(String title) {
        Product p = new Product();
        p.setTitle(title); p.setPrice(new BigDecimal("19.99")); p.setStock(10);
        return productService.save(p);
    }

    @Test
    void givenCustomer_whenGetOrCreateCart_thenCartCreated() {
        // Given
        Customer customer = createCustomer("cart1@test.com");
        // When
        Cart cart = cartService.getOrCreateCart(customer);
        // Then
        assertNotNull(cart.getId());
        assertEquals(customer.getId(), cart.getCustomer().getId());
    }

    @Test
    void givenCart_whenAddItem_thenItemInCart() {
        // Given
        Customer customer = createCustomer("cart2@test.com");
        Product product = createProduct("CartProduct");
        Cart cart = cartService.getOrCreateCart(customer);
        // When
        CartItem item = cartService.addItem(cart, product, 2);
        // Then
        assertNotNull(item.getId());
        assertEquals(2, item.getQuantity());
    }

    @Test
    void givenCartItem_whenRemove_thenRemoved() {
        // Given
        Customer customer = createCustomer("cart3@test.com");
        Product product = createProduct("RemoveMe");
        Cart cart = cartService.getOrCreateCart(customer);
        CartItem item = cartService.addItem(cart, product, 1);
        Long itemId = item.getId();
        // When
        cartService.removeItem(itemId);
        // Then — no exception means success
    }
}
`,
  'CartControllerTest.java': `package com.example.demo;

import com.example.demo.model.Cart;
import com.example.demo.model.CartItem;
import com.example.demo.model.Customer;
import com.example.demo.model.Product;
import com.example.demo.service.CartService;
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
class CartControllerTest {
    @Autowired private MockMvc mockMvc;
    @Autowired private CartService cartService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    @Test
    void givenCartItemId_whenDeleteCartItem_thenSucceeds() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        Customer c = new Customer();
        c.setEmail("cartctrl-" + uid + "@test.com"); c.setName("Ctrl"); c.setPasswordHash("hash");
        c = customerService.register(c);
        Product p = new Product();
        p.setTitle("CtrlProd"); p.setPrice(new BigDecimal("5.00")); p.setStock(5);
        p = productService.save(p);
        Cart cart = cartService.getOrCreateCart(c);
        CartItem item = cartService.addItem(cart, p, 1);
        // When / Then
        mockMvc.perform(delete("/cart/items/" + item.getId()))
            .andExpect(status().isOk());
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/Cart.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "cart")
public class Cart {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @OneToOne
    @JoinColumn(name = "customer_id", nullable = false, unique = true)
    private Customer customer;
    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    public Cart() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Customer getCustomer() { return customer; }
    public void setCustomer(Customer customer) { this.customer = customer; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }
}
`,
  'model/CartItem.java': `package com.example.demo.model;

import jakarta.persistence.*;

@Entity
@Table(name = "cart_item")
public class CartItem {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne
    @JoinColumn(name = "cart_id", nullable = false)
    private Cart cart;
    @ManyToOne
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;
    @Column(nullable = false)
    private Integer quantity;

    public CartItem() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Cart getCart() { return cart; }
    public void setCart(Cart cart) { this.cart = cart; }
    public Product getProduct() { return product; }
    public void setProduct(Product product) { this.product = product; }
    public Integer getQuantity() { return quantity; }
    public void setQuantity(Integer quantity) { this.quantity = quantity; }
}
`,
  'repository/CartRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Cart;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface CartRepository extends JpaRepository<Cart, Long> {
    Optional<Cart> findByCustomerId(Long customerId);
}
`,
  'repository/CartItemRepository.java': `package com.example.demo.repository;

import com.example.demo.model.CartItem;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CartItemRepository extends JpaRepository<CartItem, Long> {
}
`,
  'service/CartService.java': `package com.example.demo.service;

import com.example.demo.model.*;
import com.example.demo.repository.*;
import org.springframework.stereotype.Service;
import java.util.Optional;

@Service
public class CartService {
    private final CartRepository cartRepo;
    private final CartItemRepository itemRepo;
    public CartService(CartRepository cartRepo, CartItemRepository itemRepo) {
        this.cartRepo = cartRepo; this.itemRepo = itemRepo;
    }
    public Cart getOrCreateCart(Customer customer) {
        return cartRepo.findByCustomerId(customer.getId())
            .orElseGet(() -> { Cart c = new Cart(); c.setCustomer(customer); return cartRepo.save(c); });
    }
    public CartItem addItem(Cart cart, Product product, int quantity) {
        CartItem item = new CartItem();
        item.setCart(cart); item.setProduct(product); item.setQuantity(quantity);
        return itemRepo.save(item);
    }
    public void removeItem(Long itemId) { itemRepo.deleteById(itemId); }
    public void clearCart(Long cartId) { cartRepo.deleteById(cartId); }
}
`,
  'controller/CartController.java': `package com.example.demo.controller;

import com.example.demo.model.Cart;
import com.example.demo.service.CartService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/cart")
public class CartController {
    private final CartService service;
    public CartController(CartService service) { this.service = service; }

    @DeleteMapping("/items/{id}")
    public void removeItem(@PathVariable Long id) { service.removeItem(id); }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(4); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/cart branch', () => {
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
    it('A2: writes Cart Java files', () => {
      for (const [p, c] of Object.entries(JAVA_FILES)) { writeJavaFile(ctx, p, c); }
    });
    it('A3: writes V5 migration SQL', () => { writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL); });

    it('A3-verify: parseSql extracts 2 tables (cart + cart_item)', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      const created = changes.filter(c => c.type === 'created');
      assert.strictEqual(created.length, 2);
      assert.ok(created.some(c => c.tableName === 'cart'));
      assert.ok(created.some(c => c.tableName === 'cart_item'));
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
      commitAndPush(ctx, 'Add shopping cart with customer and product references', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add shopping cart', BRANCH);
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
      const schemaDiffComment = comments.find(c => c.body.includes('cart'));
      assert.ok(schemaDiffComment, 'PR comment should mention cart table');
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
    it('D1: V5 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '5')); });
    it('D2: cart table exists', async () => { assert.ok(await verifyTableExists(ctx, 'cart')); });
    it('D2: cart_item table exists', async () => { assert.ok(await verifyTableExists(ctx, 'cart_item')); });
    it('D3: files on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Cart.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/CartItem.java'));
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

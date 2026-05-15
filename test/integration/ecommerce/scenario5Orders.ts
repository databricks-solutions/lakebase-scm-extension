/**
 * Scenario 5: Order Processing
 *
 * Customers check out their cart to place orders. Stock must be validated.
 * Tests: Multiple CREATE TABLEs, FKs, CHECK constraint, NUMERIC type, enum pattern.
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

const BRANCH = 'feature/orders';
export const MIGRATION_FILE = 'V6__create_orders_and_order_item_tables.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS orders (
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
`;

export const TEST_FILES: Record<string, string> = {
  'OrderServiceTest.java': `package com.example.demo;

import com.example.demo.model.*;
import com.example.demo.service.OrderService;
import com.example.demo.service.CustomerService;
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
class OrderServiceTest {
    @Autowired private OrderService orderService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    private Customer createCustomer(String email) {
        Customer c = new Customer();
        c.setEmail(email); c.setName("Test"); c.setPasswordHash("hash");
        return customerService.register(c);
    }

    private Product createProduct(String title, int stock) {
        Product p = new Product();
        p.setTitle(title); p.setPrice(new BigDecimal("10.00")); p.setStock(stock);
        return productService.save(p);
    }

    @Test
    void givenCustomerAndItems_whenPlaceOrder_thenOrderCreated() {
        // Given
        Customer customer = createCustomer("order1@test.com");
        Product product = createProduct("OrderProd", 50);
        OrderItem item = new OrderItem();
        item.setProduct(product); item.setQuantity(2); item.setPriceAtOrder(product.getPrice());
        // When
        Order order = orderService.placeOrder(customer, List.of(item));
        // Then
        assertNotNull(order.getId());
        assertEquals(OrderStatus.PENDING, order.getStatus());
    }

    @Test
    void givenOrder_whenUpdateStatus_thenStatusChanged() {
        // Given
        Customer customer = createCustomer("order2@test.com");
        Product product = createProduct("StatusProd", 50);
        OrderItem item = new OrderItem();
        item.setProduct(product); item.setQuantity(1); item.setPriceAtOrder(product.getPrice());
        Order order = orderService.placeOrder(customer, List.of(item));
        // When
        Order updated = orderService.updateStatus(order.getId(), OrderStatus.CONFIRMED);
        // Then
        assertEquals(OrderStatus.CONFIRMED, updated.getStatus());
    }
}
`,
  'OrderControllerTest.java': `package com.example.demo;

import com.example.demo.model.*;
import com.example.demo.service.OrderService;
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
import java.util.List;
import java.util.UUID;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class OrderControllerTest {
    @Autowired private MockMvc mockMvc;
    @Autowired private OrderService orderService;
    @Autowired private CustomerService customerService;
    @Autowired private ProductService productService;

    private Customer createCustomer(String email) {
        Customer c = new Customer();
        c.setEmail(email); c.setName("Test"); c.setPasswordHash("hash");
        return customerService.register(c);
    }

    private Product createProduct(String title) {
        Product p = new Product();
        p.setTitle(title); p.setPrice(new BigDecimal("10.00")); p.setStock(50);
        return productService.save(p);
    }

    @Test
    void givenOrderId_whenGet_thenReturnsOrder() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        Customer customer = createCustomer("ordctrl1-" + uid + "@test.com");
        Product product = createProduct("CtrlProd1");
        OrderItem item = new OrderItem();
        item.setProduct(product); item.setQuantity(1); item.setPriceAtOrder(product.getPrice());
        Order order = orderService.placeOrder(customer, List.of(item));
        // When / Then
        mockMvc.perform(get("/orders/" + order.getId()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("PENDING"));
    }

    @Test
    void givenOrderId_whenPatchStatus_thenUpdated() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        Customer customer = createCustomer("ordctrl2-" + uid + "@test.com");
        Product product = createProduct("CtrlProd2");
        OrderItem item = new OrderItem();
        item.setProduct(product); item.setQuantity(1); item.setPriceAtOrder(product.getPrice());
        Order order = orderService.placeOrder(customer, List.of(item));
        // When / Then
        mockMvc.perform(patch("/orders/" + order.getId() + "/status").param("status", "SHIPPED"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("SHIPPED"));
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/OrderStatus.java': `package com.example.demo.model;

public enum OrderStatus {
    PENDING, CONFIRMED, SHIPPED, DELIVERED, CANCELLED
}
`,
  'model/Order.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.OffsetDateTime;

@Entity
@Table(name = "orders")
public class Order {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;
    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private OrderStatus status = OrderStatus.PENDING;
    @Column(nullable = false)
    private BigDecimal totalAmount;
    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    public Order() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Customer getCustomer() { return customer; }
    public void setCustomer(Customer customer) { this.customer = customer; }
    public OrderStatus getStatus() { return status; }
    public void setStatus(OrderStatus status) { this.status = status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal totalAmount) { this.totalAmount = totalAmount; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }
}
`,
  'model/OrderItem.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "order_item")
public class OrderItem {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;
    @ManyToOne
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;
    @Column(nullable = false)
    private Integer quantity;
    @Column(nullable = false)
    private BigDecimal priceAtOrder;

    public OrderItem() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Order getOrder() { return order; }
    public void setOrder(Order order) { this.order = order; }
    public Product getProduct() { return product; }
    public void setProduct(Product product) { this.product = product; }
    public Integer getQuantity() { return quantity; }
    public void setQuantity(Integer quantity) { this.quantity = quantity; }
    public BigDecimal getPriceAtOrder() { return priceAtOrder; }
    public void setPriceAtOrder(BigDecimal priceAtOrder) { this.priceAtOrder = priceAtOrder; }
}
`,
  'repository/OrderRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Order;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByCustomerId(Long customerId);
}
`,
  'repository/OrderItemRepository.java': `package com.example.demo.repository;

import com.example.demo.model.OrderItem;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderItemRepository extends JpaRepository<OrderItem, Long> {
}
`,
  'service/InsufficientStockException.java': `package com.example.demo.service;

public class InsufficientStockException extends RuntimeException {
    public InsufficientStockException(String message) { super(message); }
}
`,
  'service/OrderService.java': `package com.example.demo.service;

import com.example.demo.model.*;
import com.example.demo.repository.*;
import org.springframework.stereotype.Service;
import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

@Service
public class OrderService {
    private final OrderRepository orderRepo;
    private final OrderItemRepository itemRepo;
    private final ProductRepository productRepo;

    public OrderService(OrderRepository orderRepo, OrderItemRepository itemRepo, ProductRepository productRepo) {
        this.orderRepo = orderRepo; this.itemRepo = itemRepo; this.productRepo = productRepo;
    }

    public Order placeOrder(Customer customer, List<OrderItem> items) {
        BigDecimal total = BigDecimal.ZERO;
        for (OrderItem item : items) {
            Product p = productRepo.findById(item.getProduct().getId()).orElseThrow();
            if (p.getStock() < item.getQuantity()) {
                throw new InsufficientStockException("Insufficient stock for " + p.getTitle());
            }
            total = total.add(p.getPrice().multiply(BigDecimal.valueOf(item.getQuantity())));
        }
        Order order = new Order();
        order.setCustomer(customer);
        order.setTotalAmount(total);
        order.setStatus(OrderStatus.PENDING);
        return orderRepo.save(order);
    }

    public Optional<Order> findById(Long id) { return orderRepo.findById(id); }
    public List<Order> findByCustomer(Long customerId) { return orderRepo.findByCustomerId(customerId); }
    public Order updateStatus(Long id, OrderStatus status) {
        Order o = orderRepo.findById(id).orElseThrow();
        o.setStatus(status);
        return orderRepo.save(o);
    }
}
`,
  'controller/OrderController.java': `package com.example.demo.controller;

import com.example.demo.model.Order;
import com.example.demo.model.OrderStatus;
import com.example.demo.service.OrderService;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService service;
    public OrderController(OrderService service) { this.service = service; }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) { return service.findById(id).orElseThrow(); }

    @PatchMapping("/{id}/status")
    public Order updateStatus(@PathVariable Long id, @RequestParam OrderStatus status) {
        return service.updateStatus(id, status);
    }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(5); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/orders branch', () => {
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
    it('A2: writes Order Java files', () => {
      for (const [p, c] of Object.entries(JAVA_FILES)) { writeJavaFile(ctx, p, c); }
    });
    it('A3: writes V6 migration SQL', () => { writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL); });

    it('A3-verify: parseSql extracts orders + order_item', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      const created = changes.filter(c => c.type === 'created');
      assert.strictEqual(created.length, 2);
      assert.ok(created.some(c => c.tableName === 'orders'));
      assert.ok(created.some(c => c.tableName === 'order_item'));
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
      commitAndPush(ctx, 'Add order processing with stock validation', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add order processing with stock validation', BRANCH);
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
      const schemaDiffComment = comments.find(c => c.body.includes('orders'));
      assert.ok(schemaDiffComment, 'PR comment should mention orders table');
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
    it('D1: V6 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '6')); });
    it('D2: orders table exists', async () => { assert.ok(await verifyTableExists(ctx, 'orders')); });
    it('D2: order_item table exists', async () => { assert.ok(await verifyTableExists(ctx, 'order_item')); });
    it('D3: files on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Order.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/OrderItem.java'));
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

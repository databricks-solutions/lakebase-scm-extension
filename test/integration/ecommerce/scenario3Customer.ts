/**
 * Scenario 3: Customer Registration
 *
 * Customers need to create accounts to shop.
 * Tests: CREATE TABLE with UNIQUE constraint, TIMESTAMP WITH TIME ZONE, DEFAULT.
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

const BRANCH = 'feature/customer';
export const MIGRATION_FILE = 'V4__create_customer_table.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS customer (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export const TEST_FILES: Record<string, string> = {
  'CustomerServiceTest.java': `package com.example.demo;

import com.example.demo.model.Customer;
import com.example.demo.service.CustomerService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

import java.util.Optional;

@SpringBootTest
@Transactional
class CustomerServiceTest {
    @Autowired private CustomerService customerService;

    @Test
    void givenCustomer_whenRegistered_thenCanFindByEmail() {
        // Given
        Customer customer = new Customer();
        customer.setEmail("test@example.com");
        customer.setName("Test User");
        customer.setPasswordHash("hashed123");
        // When
        customerService.register(customer);
        // Then
        Optional<Customer> found = customerService.findByEmail("test@example.com");
        assertTrue(found.isPresent());
        assertEquals("Test User", found.get().getName());
    }

    @Test
    void givenCustomerId_whenFindById_thenFound() {
        // Given
        Customer customer = new Customer();
        customer.setEmail("byid@example.com");
        customer.setName("ById User");
        customer.setPasswordHash("hashed456");
        Customer saved = customerService.register(customer);
        // When
        Optional<Customer> found = customerService.findById(saved.getId());
        // Then
        assertTrue(found.isPresent());
        assertEquals("byid@example.com", found.get().getEmail());
    }
}
`,
  'CustomerControllerTest.java': `package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import java.util.UUID;

@SpringBootTest
@AutoConfigureMockMvc
class CustomerControllerTest {
    @Autowired private MockMvc mockMvc;

    @Test
    void givenCustomerPayload_whenPostCustomers_thenCreated() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        String email = "ctrl-" + uid + "@example.com";
        String json = "{\\"email\\":\\"" + email + "\\",\\"name\\":\\"Ctrl User\\",\\"passwordHash\\":\\"hash789\\"}";
        // When / Then
        mockMvc.perform(post("/customers").contentType(MediaType.APPLICATION_JSON).content(json))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.email").value(email));
    }

    @Test
    void givenCustomerId_whenGet_thenReturnsCustomer() throws Exception {
        // Given
        String uid = UUID.randomUUID().toString().substring(0, 8);
        String email = "get-" + uid + "@example.com";
        String json = "{\\"email\\":\\"" + email + "\\",\\"name\\":\\"Get User\\",\\"passwordHash\\":\\"hashabc\\"}";
        String response = mockMvc.perform(post("/customers").contentType(MediaType.APPLICATION_JSON).content(json))
            .andReturn().getResponse().getContentAsString();
        String id = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response).get("id").asText();
        // When / Then
        mockMvc.perform(get("/customers/" + id))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.name").value("Get User"));
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/Customer.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "customer")
public class Customer {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false, unique = true)
    private String email;
    @Column(nullable = false)
    private String name;
    @Column(nullable = false)
    private String passwordHash;
    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    public Customer() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }
}
`,
  'repository/CustomerRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Customer;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface CustomerRepository extends JpaRepository<Customer, Long> {
    Optional<Customer> findByEmail(String email);
}
`,
  'service/CustomerService.java': `package com.example.demo.service;

import com.example.demo.model.Customer;
import com.example.demo.repository.CustomerRepository;
import org.springframework.stereotype.Service;
import java.util.Optional;

@Service
public class CustomerService {
    private final CustomerRepository repo;
    public CustomerService(CustomerRepository repo) { this.repo = repo; }
    public Customer register(Customer customer) { return repo.save(customer); }
    public Optional<Customer> findByEmail(String email) { return repo.findByEmail(email); }
    public Optional<Customer> findById(Long id) { return repo.findById(id); }
}
`,
  'controller/CustomerController.java': `package com.example.demo.controller;

import com.example.demo.model.Customer;
import com.example.demo.service.CustomerService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/customers")
public class CustomerController {
    private final CustomerService service;
    public CustomerController(CustomerService service) { this.service = service; }

    @PostMapping
    public Customer register(@RequestBody Customer customer) { return service.register(customer); }

    @GetMapping("/{id}")
    public Customer get(@PathVariable Long id) { return service.findById(id).orElseThrow(); }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(3); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/customer branch', () => {
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
    it('A2: writes Customer Java files', () => {
      for (const [p, c] of Object.entries(JAVA_FILES)) { writeJavaFile(ctx, p, c); }
    });
    it('A3: writes V4 migration SQL', () => { writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL); });

    it('A3-verify: parseSql extracts customer table', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      assert.strictEqual(changes[0].tableName, 'customer');
      assert.ok(changes[0].columns.some(c => c.name === 'email'));
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
      commitAndPush(ctx, 'Add customer registration with email uniqueness', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add customer registration', BRANCH);
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
      const schemaDiffComment = comments.find(c => c.body.includes('customer'));
      assert.ok(schemaDiffComment, 'PR comment should mention customer table');
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
    it('D1: V4 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '4')); });
    it('D2: customer table exists', async () => { assert.ok(await verifyTableExists(ctx, 'customer')); });
    it('D3: files on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Customer.java'));
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

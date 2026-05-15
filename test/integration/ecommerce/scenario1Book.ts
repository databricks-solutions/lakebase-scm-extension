/**
 * Scenario 1: Book Entity (Initial Feature)
 *
 * Developer adds a book catalog to the new e-commerce app.
 * Tests: CREATE TABLE, JPA entity, full CRUD, first PR through the pipeline.
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writeJavaFile, writeMigration,
  commitAndPush, createPR, mergePR, pullMain, cleanupBranch,
  waitForWorkflowRun, getLatestRunId, getWorkflowLogs, getPRComments,
  verifyTableExists, verifyMigrationApplied, verifyFileOnGitHub,
  parseMigrationSql, deleteLakebaseBranch, pauseIfRequested,
  verifyBranchConnection, createLakebaseBranchAndConnect, writeJavaTestFile, deleteJavaTestFile, runMavenTests,
  setCurrentScenario, waitForRunnerIdle,
} from './helpers';

const BRANCH = 'feature/book';
export const MIGRATION_FILE = 'V2__create_book_table.sql';
export const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS book (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255),
    price DECIMAL(19, 2),
    publish_date DATE
);
`;

export const TEST_FILES: Record<string, string> = {
  'BookServiceTest.java': `package com.example.demo;

import com.example.demo.model.Book;
import com.example.demo.service.BookService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@SpringBootTest
@Transactional
class BookServiceTest {
    @Autowired private BookService bookService;

    @Test
    void givenNewBook_whenSaved_thenCanBeRetrievedById() {
        // Given
        Book book = new Book("Test Book", new BigDecimal("29.99"), LocalDate.now());
        // When
        Book saved = bookService.save(book);
        // Then
        Optional<Book> found = bookService.findById(saved.getId());
        assertTrue(found.isPresent());
        assertEquals("Test Book", found.get().getTitle());
    }

    @Test
    void givenBooks_whenFindAll_thenReturnsAll() {
        // Given
        bookService.save(new Book("Book A", new BigDecimal("19.99"), LocalDate.now()));
        bookService.save(new Book("Book B", new BigDecimal("24.99"), LocalDate.now()));
        // When
        List<Book> all = bookService.findAll();
        // Then
        assertTrue(all.size() >= 2);
    }

    @Test
    void givenBookId_whenDeleted_thenNotFound() {
        // Given
        Book saved = bookService.save(new Book("Doomed", new BigDecimal("9.99"), LocalDate.now()));
        Long id = saved.getId();
        // When
        bookService.delete(id);
        // Then
        assertFalse(bookService.findById(id).isPresent());
    }
}
`,
  'BookControllerTest.java': `package com.example.demo;

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
class BookControllerTest {
    @Autowired private MockMvc mockMvc;

    @Test
    void givenBookPayload_whenPostBooks_thenReturnsCreated() throws Exception {
        // Given
        String json = "{\\"title\\":\\"Test\\",\\"price\\":29.99,\\"publishDate\\":\\"2024-01-01\\"}";
        // When / Then
        mockMvc.perform(post("/books").contentType(MediaType.APPLICATION_JSON).content(json))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.title").value("Test"));
    }

    @Test
    void givenExistingBooks_whenGetBooks_thenReturnsList() throws Exception {
        // Given
        String json = "{\\"title\\":\\"Listed\\",\\"price\\":15.00,\\"publishDate\\":\\"2024-01-01\\"}";
        mockMvc.perform(post("/books").contentType(MediaType.APPLICATION_JSON).content(json));
        // When / Then
        mockMvc.perform(get("/books"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$").isArray());
    }

    @Test
    void givenBookId_whenDelete_thenSucceeds() throws Exception {
        // Given
        String json = "{\\"title\\":\\"ToDelete\\",\\"price\\":5.00,\\"publishDate\\":\\"2024-01-01\\"}";
        String response = mockMvc.perform(post("/books").contentType(MediaType.APPLICATION_JSON).content(json))
            .andReturn().getResponse().getContentAsString();
        String id = com.fasterxml.jackson.databind.ObjectMapper.class.getDeclaredConstructor().newInstance()
            .readTree(response).get("id").asText();
        // When / Then
        mockMvc.perform(delete("/books/" + id))
            .andExpect(status().isOk());
    }
}
`,
};

export const JAVA_FILES: Record<string, string> = {
  'model/Book.java': `package com.example.demo.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;

@Entity
@Table(name = "book")
public class Book {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String title;
    private BigDecimal price;
    private LocalDate publishDate;

    public Book() {}
    public Book(String title, BigDecimal price, LocalDate publishDate) {
        this.title = title; this.price = price; this.publishDate = publishDate;
    }
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }
    public LocalDate getPublishDate() { return publishDate; }
    public void setPublishDate(LocalDate publishDate) { this.publishDate = publishDate; }
}
`,
  'repository/BookRepository.java': `package com.example.demo.repository;

import com.example.demo.model.Book;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BookRepository extends JpaRepository<Book, Long> {
}
`,
  'service/BookService.java': `package com.example.demo.service;

import com.example.demo.model.Book;
import com.example.demo.repository.BookRepository;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.Optional;

@Service
public class BookService {
    private final BookRepository repo;
    public BookService(BookRepository repo) { this.repo = repo; }
    public List<Book> findAll() { return repo.findAll(); }
    public Optional<Book> findById(Long id) { return repo.findById(id); }
    public Book save(Book book) { return repo.save(book); }
    public void delete(Long id) { repo.deleteById(id); }
}
`,
  'controller/BookController.java': `package com.example.demo.controller;

import com.example.demo.model.Book;
import com.example.demo.service.BookService;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/books")
public class BookController {
    private final BookService service;
    public BookController(BookService service) { this.service = service; }

    @GetMapping
    public List<Book> list() { return service.findAll(); }

    @GetMapping("/{id}")
    public Book get(@PathVariable Long id) {
        return service.findById(id).orElseThrow();
    }

    @PostMapping
    public Book create(@RequestBody Book book) { return service.save(book); }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) { service.delete(id); }
}
`,
};

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  // ── Phase A: Developer ───────────────────────────────────────────

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(1); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
      // Pause gate: if ECOM_PAUSE_AT matches the test name, wait for signal
      const testTitle = this.currentTest?.title || '';
      const stepName = testTitle.split(':')[0]?.trim();
      if (stepName && this.currentTest?.state === 'passed') { pauseIfRequested(stepName, ctx); }
    });

    it('A1: creates feature/book branch', () => {
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

    it('A2: writes 4 Java files', () => {
      for (const [relPath, content] of Object.entries(JAVA_FILES)) {
        writeJavaFile(ctx, relPath, content);
      }
      const fs = require('fs');
      const path = require('path');
      for (const relPath of Object.keys(JAVA_FILES)) {
        const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', relPath);
        assert.ok(fs.existsSync(fullPath), `${relPath} should exist`);
      }
    });

    it('A3: writes V2 migration SQL', () => {
      writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL);
      const fs = require('fs');
      const path = require('path');
      const migPath = path.join(ctx.projectDir, 'src', 'main', 'resources', 'db', 'migration', MIGRATION_FILE);
      assert.ok(fs.existsSync(migPath), 'Migration file should exist');
    });

    it('A3-verify: parseSql extracts CREATE TABLE book', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].type, 'created');
      assert.strictEqual(changes[0].tableName, 'book');
      assert.ok(changes[0].columns.some(c => c.name === 'title'));
      assert.ok(changes[0].columns.some(c => c.name === 'price'));
      assert.ok(changes[0].columns.some(c => c.name === 'publish_date'));
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
      commitAndPush(ctx, 'Add book entity with CRUD', BRANCH);
      const log = git(ctx, 'log --oneline -1');
      assert.ok(log.includes('Add book entity with CRUD'));
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    afterEach(function () {
      const stepName = (this.currentTest?.title || '').split(':')[0]?.trim();
      if (stepName && this.currentTest?.state === 'passed') { pauseIfRequested(stepName, ctx); }
    });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add book entity with CRUD', BRANCH);
      assert.ok(prNumber > 0, `PR number should be positive, got ${prNumber}`);
    });

    it('B2: pr.yml succeeds (Flyway + tests on branch DB)', () => {
      const result = waitForWorkflowRun(ctx, 'pr.yml', { branch: BRANCH, event: 'pull_request' });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`pr.yml failed (${result.conclusion}). Run ${result.runId}. Logs:\n${logs}`);
      }
    });

    it('B3: PR comment contains schema diff showing book table', () => {
      const comments = getPRComments(ctx, prNumber);
      assert.ok(comments.length > 0, 'PR should have at least one comment from the workflow');
      const schemaDiffComment = comments.find(c => c.body.includes('book'));
      assert.ok(schemaDiffComment, 'PR should have a comment mentioning the book table');
      assert.ok(schemaDiffComment!.body.includes('CREATED') || schemaDiffComment!.body.includes('CREATE') || schemaDiffComment!.body.includes('schema'),
        'Schema diff comment should indicate table creation');
    });
  });

  describe('Phase C: Merge workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    afterEach(function () {
      const stepName = (this.currentTest?.title || '').split(':')[0]?.trim();
      if (stepName && this.currentTest?.state === 'passed') { pauseIfRequested(stepName, ctx); }
    });
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

  // ── Phase D: Post-Merge Verification ─────────────────────────────

  describe('Phase D: Verification', function () {
    this.timeout(60000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('D1: V2 is in flyway_schema_history', async () => {
      const applied = await verifyMigrationApplied(ctx, '2');
      assert.ok(applied, 'V2 should be applied');
    });

    it('D2: book table exists on production', async () => {
      const exists = await verifyTableExists(ctx, 'book');
      assert.ok(exists, 'book table should exist');
    });

    it('D3: Java files visible on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Book.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/controller/BookController.java'));
    });

    it('D4: cleanup feature branch', async () => {
      cleanupBranch(ctx, BRANCH);
      await deleteLakebaseBranch(ctx, BRANCH);
    });

    it('D5: wait for runner idle', function () {
      this.timeout(300000);
      waitForRunnerIdle(ctx);
    });
  });
}

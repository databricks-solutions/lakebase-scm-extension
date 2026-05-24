/**
 * Python Project Scaffolding
 *
 * Injects a FastAPI + SQLAlchemy + Alembic project into an existing scaffolded directory.
 * Mirrors the template structure in templates/project/python/ but writes files directly
 * so the test controls exactly what goes into the initial commit.
 */

import * as fs from 'fs';
import * as path from 'path';

export function scaffoldPythonProject(projectDir: string): void {
  const write = (rel: string, content: string) => {
    const full = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  // ── pyproject.toml ──────────────────────────────────────────────
  write('pyproject.toml', `[project]
name = "devloop-test"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn>=0.27.0",
    "sqlalchemy>=2.0.25",
    "alembic>=1.13.0",
    "psycopg[binary]>=3.1.0",
    "python-dotenv>=1.0.0",
    "httpx>=0.27.0",
    "pytest>=8.0.0",
]
`);

  // ── alembic.ini ─────────────────────────────────────────────────
  write('alembic.ini', `[alembic]
script_location = alembic
sqlalchemy.url = driver://user:pass@localhost/dbname

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
`);

  // ── alembic/env.py ──────────────────────────────────────────────
  write('alembic/env.py', `import sys
from pathlib import Path

# Ensure the project root is on sys.path so 'from app.database import ...' works
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context
from app.database import Base, DATABASE_URL

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=DATABASE_URL, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
`);

  // ── alembic/script.py.mako ──────────────────────────────────────
  write('alembic/script.py.mako', `"""$\{message}

Revision ID: $\{up_revision}
Revises: $\{down_revision | comma,n}
Create Date: $\{create_date}
"""
from alembic import op
import sqlalchemy as sa
$\{imports if imports else ""}

revision = $\{repr(up_revision)}
down_revision = $\{repr(down_revision)}
branch_labels = $\{repr(branch_labels)}
depends_on = $\{repr(depends_on)}


def upgrade() -> None:
    $\{upgrades if upgrades else "pass"}


def downgrade() -> None:
    $\{downgrades if downgrades else "pass"}
`);

  // ── alembic/versions/001_init_placeholder.py ────────────────────
  write('alembic/versions/001_init_placeholder.py', `"""init placeholder

Revision ID: 001
Revises:
Create Date: auto
"""
from alembic import op
import sqlalchemy as sa

revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
`);

  // ── app/__init__.py ─────────────────────────────────────────────
  write('app/__init__.py', '');

  // ── app/database.py ─────────────────────────────────────────────
  write('app/database.py', `import os
from pathlib import Path
from urllib.parse import quote_plus
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


def _build_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        if "sslmode" not in url:
            url += "?sslmode=require"
        return url
    host = os.getenv("LAKEBASE_HOST", os.getenv("DB_HOST", "localhost"))
    user = os.getenv("DB_USERNAME", "postgres")
    password = os.getenv("DB_PASSWORD", "postgres")
    dbname = os.getenv("DB_NAME", "databricks_postgres")
    return f"postgresql+psycopg://{quote_plus(user)}:{quote_plus(password)}@{host}:5432/{dbname}?sslmode=require"


DATABASE_URL = _build_url()
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass
`);

  // ── app/models.py (empty initially — scenarios add models) ──────
  write('app/models.py', `from app.database import Base
`);

  // ── app/main.py ─────────────────────────────────────────────────
  write('app/main.py', `from fastapi import FastAPI

app = FastAPI(title="devloop-test")


@app.get("/health")
def health():
    return {"status": "ok"}
`);

  // ── tests/__init__.py ───────────────────────────────────────────
  write('tests/__init__.py', '');

  // ── tests/conftest.py ───────────────────────────────────────────
  write('tests/conftest.py', `import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.database import DATABASE_URL, Base
from app.main import app


@pytest.fixture(scope="session")
def engine():
    return create_engine(DATABASE_URL)


@pytest.fixture(scope="session")
def tables(engine):
    Base.metadata.create_all(engine)
    yield
    # Don't drop — Alembic owns the schema


@pytest.fixture
def db_session(engine, tables):
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.rollback()
    session.close()


@pytest.fixture
def client():
    return TestClient(app)
`);

  // ── tests/test_health.py ────────────────────────────────────────
  write('tests/test_health.py', `def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
`);

  // ── .gitignore additions ────────────────────────────────────────
  const gitignorePath = path.join(projectDir, '.gitignore');
  let gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const pyIgnores = '\n# Python\n__pycache__/\n*.pyc\n.venv/\n*.egg-info/\n';
  if (!gitignore.includes('__pycache__')) {
    gitignore += pyIgnores;
    fs.writeFileSync(gitignorePath, gitignore);
  }

  console.log('    [scaffold] Python project files written.');
}

@"
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS courses;

CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    gpa REAL,
    department_id INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    department_id INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(id)
);

INSERT INTO departments (id, name) VALUES
    (1, 'Computer Science'),
    (2, 'Mathematics'),
    (3, 'Physics');

INSERT INTO students (id, name, gpa, department_id) VALUES
    (1, 'Alice', 9.2, 1),
    (2, 'Bob', 8.4, 1),
    (3, 'Charlie', 7.8, 2),
    (4, 'Diana', 9.5, 1),
    (5, 'Ethan', 8.9, 3),
    (6, 'Fiona', 7.2, 2),
    (7, 'George', 9.0, 1),
    (8, 'Hannah', 8.1, 3);

INSERT INTO courses (id, name, credits, department_id) VALUES
    (1, 'Database Systems', 4, 1),
    (2, 'Algorithms', 4, 1),
    (3, 'Calculus', 3, 2),
    (4, 'Linear Algebra', 3, 2),
    (5, 'Quantum Mechanics', 4, 3),
    (6, 'Classical Mechanics', 3, 3);

"@ | Set-Content seed.sql

Get-Content seed.sql | sqlite3 test.sqlite


Write-Host "Created test.sqlite successfully."

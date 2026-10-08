PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS club_memberships;
DROP TABLE IF EXISTS clubs;
DROP TABLE IF EXISTS scholarships;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS course_offerings;
DROP TABLE IF EXISTS student_projects;
DROP TABLE IF EXISTS professors;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS departments;

CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    gpa REAL CHECK (gpa BETWEEN 0 AND 10),
    year INTEGER CHECK (year BETWEEN 1 AND 4),
    department_id INTEGER,
    admission_year INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE professors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    department_id INTEGER NOT NULL,
    salary INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE courses (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    level INTEGER NOT NULL,
    department_id INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE course_offerings (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL,
    professor_id INTEGER NOT NULL,
    semester TEXT NOT NULL,
    academic_year INTEGER NOT NULL,
    room TEXT,
    capacity INTEGER NOT NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id),
    FOREIGN KEY (professor_id) REFERENCES professors(id)
);

CREATE TABLE enrollments (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL,
    course_offering_id INTEGER NOT NULL,
    grade REAL,
    status TEXT NOT NULL DEFAULT 'enrolled',
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (course_offering_id) REFERENCES course_offerings(id),
    UNIQUE(student_id, course_offering_id)
);

CREATE TABLE scholarships (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    awarded_year INTEGER NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE clubs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    founded_year INTEGER
);

CREATE TABLE club_memberships (
    student_id INTEGER NOT NULL,
    club_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'Member',
    joined_year INTEGER NOT NULL,
    PRIMARY KEY (student_id, club_id),
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (club_id) REFERENCES clubs(id)
);

CREATE TABLE student_projects (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    technology TEXT,
    start_year INTEGER,
    status TEXT NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id)
);


-- ============================================================
-- DEPARTMENTS
-- ============================================================

INSERT INTO departments (id, name) VALUES
    (1, 'Computer Science'),
    (2, 'Mathematics'),
    (3, 'Physics'),
    (4, 'Electrical Engineering'),
    (5, 'Business Administration');


-- ============================================================
-- STUDENTS
-- ============================================================

INSERT INTO students
    (id, name, email, gpa, year, department_id, admission_year)
VALUES
    (1, 'Alice',   'alice@university.edu',   9.2, 4, 1, 2023),
    (2, 'Bob',     'bob@university.edu',     8.4, 3, 1, 2024),
    (3, 'Charlie', 'charlie@university.edu', 7.8, 2, 2, 2025),
    (4, 'Diana',   'diana@university.edu',   9.5, 4, 1, 2023),
    (5, 'Ethan',   'ethan@university.edu',   8.9, 3, 3, 2024),
    (6, 'Fiona',   'fiona@university.edu',   7.2, 2, 2, 2025),
    (7, 'George',  'george@university.edu',  9.0, 3, 1, 2024),
    (8, 'Hannah',  'hannah@university.edu',  8.1, 2, 3, 2025),
    (9, 'Irene',   'irene@university.edu',   9.7, 4, 4, 2023),
    (10, 'Jack',   'jack@university.edu',    7.9, 3, 4, 2024),
    (11, 'Karen',  'karen@university.edu',   8.7, 2, 5, 2025),
    (12, 'Leo',    'leo@university.edu',     8.3, 4, 5, 2023);


-- ============================================================
-- PROFESSORS
-- ============================================================

INSERT INTO professors
    (id, name, title, department_id, salary)
VALUES
    (1, 'Dr. Smith',   'Professor',          1, 120000),
    (2, 'Dr. Johnson', 'Associate Professor', 1, 105000),
    (3, 'Dr. Williams','Professor',           2, 118000),
    (4, 'Dr. Brown',   'Assistant Professor', 2, 92000),
    (5, 'Dr. Davis',   'Professor',           3, 125000),
    (6, 'Dr. Wilson',  'Associate Professor', 3, 108000),
    (7, 'Dr. Taylor',  'Professor',           4, 130000),
    (8, 'Dr. Anderson','Assistant Professor', 4, 90000),
    (9, 'Dr. Thomas',  'Professor',           5, 115000);


-- ============================================================
-- COURSES
-- ============================================================

INSERT INTO courses
    (id, code, name, credits, level, department_id)
VALUES
    (1,  'CS101', 'Introduction to Programming',  4, 100, 1),
    (2,  'CS201', 'Database Systems',             4, 200, 1),
    (3,  'CS301', 'Algorithms',                   4, 300, 1),
    (4,  'CS401', 'Machine Learning',             4, 400, 1),
    (5,  'MATH101', 'Calculus I',                 3, 100, 2),
    (6,  'MATH201', 'Linear Algebra',             3, 200, 2),
    (7,  'MATH301', 'Probability',                3, 300, 2),
    (8,  'PHY101', 'Classical Mechanics',         3, 100, 3),
    (9,  'PHY301', 'Quantum Mechanics',           4, 300, 3),
    (10, 'EE201',  'Digital Systems',             4, 200, 4),
    (11, 'EE301',  'Signal Processing',           4, 300, 4),
    (12, 'BUS101', 'Principles of Management',    3, 100, 5),
    (13, 'BUS301', 'Financial Analytics',         3, 300, 5);


-- ============================================================
-- COURSE OFFERINGS
-- ============================================================

INSERT INTO course_offerings
    (id, course_id, professor_id, semester, academic_year, room, capacity)
VALUES
    (1,  1, 1, 'Fall',   2025, 'CS-101', 40),
    (2,  2, 2, 'Fall',   2025, 'CS-201', 35),
    (3,  3, 1, 'Spring', 2026, 'CS-301', 30),
    (4,  4, 2, 'Spring', 2026, 'CS-401', 25),
    (5,  5, 3, 'Fall',   2025, 'MATH-101', 50),
    (6,  6, 4, 'Fall',   2025, 'MATH-201', 40),
    (7,  7, 3, 'Spring', 2026, 'MATH-301', 35),
    (8,  8, 5, 'Fall',   2025, 'PHY-101', 45),
    (9,  9, 6, 'Spring', 2026, 'PHY-301', 30),
    (10, 10, 7, 'Fall',  2025, 'EE-201', 40),
    (11, 11, 8, 'Spring', 2026, 'EE-301', 30),
    (12, 12, 9, 'Fall',  2025, 'BUS-101', 60),
    (13, 13, 9, 'Spring', 2026, 'BUS-301', 40);


-- ============================================================
-- ENROLLMENTS
-- ============================================================

INSERT INTO enrollments
    (id, student_id, course_offering_id, grade, status)
VALUES
    (1,  1, 1, 9.1, 'completed'),
    (2,  1, 2, 9.4, 'completed'),
    (3,  1, 3, 9.6, 'completed'),
    (4,  1, 4, 9.2, 'enrolled'),

    (5,  2, 1, 8.2, 'completed'),
    (6,  2, 2, 8.7, 'completed'),
    (7,  2, 3, 8.5, 'completed'),

    (8,  3, 5, 7.5, 'completed'),
    (9,  3, 6, 8.1, 'completed'),
    (10, 3, 7, 8.0, 'enrolled'),

    (11, 4, 1, 9.6, 'completed'),
    (12, 4, 2, 9.8, 'completed'),
    (13, 4, 3, 9.7, 'completed'),
    (14, 4, 4, 9.9, 'enrolled'),

    (15, 5, 8, 8.8, 'completed'),
    (16, 5, 9, 9.1, 'enrolled'),
    (17, 5, 5, 8.6, 'completed'),

    (18, 6, 5, 7.0, 'completed'),
    (19, 6, 6, 7.4, 'completed'),
    (20, 6, 7, 7.2, 'enrolled'),

    (21, 7, 1, 8.9, 'completed'),
    (22, 7, 2, 9.0, 'completed'),
    (23, 7, 3, 9.3, 'completed'),

    (24, 8, 8, 8.0, 'completed'),
    (25, 8, 9, 8.4, 'enrolled'),

    (26, 9, 10, 9.8, 'completed'),
    (27, 9, 11, 9.6, 'enrolled'),

    (28, 10, 10, 7.8, 'completed'),
    (29, 10, 11, 8.2, 'enrolled'),

    (30, 11, 12, 8.5, 'completed'),
    (31, 11, 13, 8.9, 'enrolled'),

    (32, 12, 12, 8.0, 'completed'),
    (33, 12, 13, 8.4, 'enrolled');


-- ============================================================
-- SCHOLARSHIPS
-- ============================================================

INSERT INTO scholarships
    (id, student_id, name, amount, awarded_year)
VALUES
    (1,  1, 'Academic Excellence', 50000, 2025),
    (2,  4, 'Academic Excellence', 75000, 2025),
    (3,  5, 'Science Talent',      40000, 2025),
    (4,  7, 'Academic Excellence', 50000, 2025),
    (5,  9, 'Engineering Merit',   80000, 2025),
    (6,  11, 'Business Leader',    30000, 2025),
    (7,  4, 'Research Grant',      25000, 2026),
    (8,  9, 'Research Grant',      30000, 2026);


-- ============================================================
-- CLUBS
-- ============================================================

INSERT INTO clubs
    (id, name, category, founded_year)
VALUES
    (1, 'Coding Club',       'Technology', 2018),
    (2, 'AI Society',        'Technology', 2020),
    (3, 'Math Circle',       'Academic',   2015),
    (4, 'Physics Society',   'Academic',   2016),
    (5, 'Robotics Club',     'Engineering',2019),
    (6, 'Entrepreneurship',  'Business',   2021),
    (7, 'Chess Club',        'Recreation', 2012);


INSERT INTO club_memberships
    (student_id, club_id, role, joined_year)
VALUES
    (1,  1, 'President', 2024),
    (1,  2, 'Member',    2024),
    (1,  5, 'Member',    2025),

    (2,  1, 'Member',    2024),
    (2,  5, 'Member',    2025),

    (3,  3, 'Member',    2025),
    (3,  7, 'Member',    2025),

    (4,  1, 'Vice President', 2024),
    (4,  2, 'President',      2024),
    (4,  5, 'Member',         2024),

    (5,  4, 'President', 2024),
    (5,  7, 'Member',    2025),

    (6,  3, 'Member',    2025),

    (7,  1, 'Member',    2024),
    (7,  2, 'Member',    2025),

    (8,  4, 'Member',    2025),

    (9,  5, 'President', 2024),
    (9,  2, 'Member',    2024),

    (10, 5, 'Member',    2025),

    (11, 6, 'President', 2025),
    (12, 6, 'Member',    2024),
    (12, 7, 'Member',    2024);


-- ============================================================
-- PROJECTS
-- ============================================================

INSERT INTO student_projects
    (id, student_id, title, technology, start_year, status)
VALUES
    (1,  1, 'Campus Event Recommendation System', 'Python, ML', 2025, 'Completed'),
    (2,  2, 'SQL Query Optimizer',               'Python, SQLite', 2025, 'In Progress'),
    (3,  4, 'AI Study Assistant',                'Python, LLM', 2025, 'Completed'),
    (4,  4, 'Student Performance Predictor',     'Python, ML', 2026, 'In Progress'),
    (5,  5, 'Quantum Simulation',                'Python, NumPy', 2025, 'In Progress'),
    (6,  7, 'Course Scheduling Optimizer',       'Python, OR-Tools', 2025, 'Completed'),
    (7,  9, 'Smart Traffic Controller',          'C++, Embedded', 2025, 'In Progress'),
    (8,  9, 'Signal Classification Model',       'Python, ML', 2026, 'In Progress'),
    (9,  11, 'Financial Risk Dashboard',         'Python, SQL', 2025, 'Completed'),
    (10, 12, 'Startup Recommendation Engine',    'Python, ML', 2025, 'In Progress');
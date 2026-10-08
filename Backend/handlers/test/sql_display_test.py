from handlers.sql_display import format_sql_for_display


def test_format_sql_for_display_renders_parameters_and_simple_identifiers():
    sql = 'SELECT * FROM "students" WHERE "gpa" > ? AND "name" = ?'

    assert format_sql_for_display(sql, (8.5, "O'Reilly")) == (
        "SELECT * FROM students WHERE gpa > 8.5 AND name = 'O''Reilly'"
    )


def test_format_sql_for_display_preserves_literals_and_reserved_identifiers():
    sql = 'SELECT "order" FROM "students" WHERE "note" = \'why?\' AND "id" = ?'

    assert format_sql_for_display(sql, (4,)) == (
        'SELECT "order" FROM students WHERE note = \'why?\' AND id = 4'
    )


def test_format_sql_for_display_rejects_placeholder_mismatches():
    try:
        format_sql_for_display("SELECT ?", ())
    except ValueError as exc:
        assert str(exc) == "SQL has more placeholders than bound parameters"
    else:
        raise AssertionError("Expected mismatched placeholders to raise ValueError")

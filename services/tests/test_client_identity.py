from common.db import normalize_phone, _identity_norm


def test_identity_norm_email():
    assert _identity_norm("email", " Client@Example.COM ") == "client@example.com"


def test_identity_norm_phone():
    assert _identity_norm("phone", "8 (999) 123-45-67") == "+79991234567"
    assert normalize_phone("+79991234567") == "+79991234567"


def test_identity_norm_inn():
    assert _identity_norm("inn", "ИНН 7707083893") == "7707083893"

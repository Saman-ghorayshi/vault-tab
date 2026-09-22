import test from 'node:test';
import assert from 'node:assert';

// The parser logic replicated for unit testing
function parse_search_query(query) {
  const terms = [];
  const regex = /(-)?(?:(domain|url|title):)?(?:"([^"]+)"|([^\s]+))/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const is_negation = !!match[1];
    const field = match[2];
    const value = (match[3] || match[4])?.toLowerCase();
    if (value) {
      terms.push({ is_negation, field, value });
    }
  }
  return terms;
}

function evaluate_tab_search(terms, title_text, url_text) {
  for (const term of terms) {
    let matched = false;
    if (term.field === 'domain' || term.field === 'url') {
      matched = url_text.includes(term.value);
    } else if (term.field === 'title') {
      matched = title_text.includes(term.value);
    } else {
      matched = title_text.includes(term.value) || url_text.includes(term.value);
    }
    
    if (term.is_negation ? matched : !matched) {
      return false; 
    }
  }
  return true;
}

test('AST Search Parser - basic text', () => {
  const terms = parse_search_query('github');
  assert.strictEqual(terms.length, 1);
  assert.strictEqual(terms[0].value, 'github');
  assert.strictEqual(terms[0].field, undefined);
  assert.strictEqual(terms[0].is_negation, false);
});

test('AST Search Parser - domain filter', () => {
  const terms = parse_search_query('domain:github.com');
  assert.strictEqual(terms.length, 1);
  assert.strictEqual(terms[0].value, 'github.com');
  assert.strictEqual(terms[0].field, 'domain');
  assert.strictEqual(terms[0].is_negation, false);
});

test('AST Search Parser - exact quotes', () => {
  const terms = parse_search_query('"machine learning"');
  assert.strictEqual(terms.length, 1);
  assert.strictEqual(terms[0].value, 'machine learning');
});

test('AST Search Parser - complex query', () => {
  const terms = parse_search_query('domain:github.com "machine learning" -AI title:vault');
  assert.strictEqual(terms.length, 4);
  assert.strictEqual(terms[0].field, 'domain');
  assert.strictEqual(terms[0].value, 'github.com');
  
  assert.strictEqual(terms[1].value, 'machine learning');
  assert.strictEqual(terms[1].field, undefined);
  
  assert.strictEqual(terms[2].value, 'ai');
  assert.strictEqual(terms[2].is_negation, true);
  
  assert.strictEqual(terms[3].field, 'title');
  assert.strictEqual(terms[3].value, 'vault');
});

test('AST Search Evaluator - evaluation logic', () => {
  const terms = parse_search_query('domain:github.com -login');
  
  // Tab 1: github.com/repo, title: my repo (should match)
  assert.strictEqual(evaluate_tab_search(terms, 'my repo', 'https://github.com/repo'), true);
  
  // Tab 2: github.com/login, title: sign in (should fail due to -login)
  assert.strictEqual(evaluate_tab_search(terms, 'sign in', 'https://github.com/login'), false);
  
  // Tab 3: gitlab.com/repo, title: repo (should fail due to domain:github.com)
  assert.strictEqual(evaluate_tab_search(terms, 'repo', 'https://gitlab.com/repo'), false);
});

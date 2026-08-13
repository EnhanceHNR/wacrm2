import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  console.log('Checking tags...');
  const { data: msgs, error: err } = await supabase
    .from('tags')
    .select('*')
    .limit(5);
  if (err) {
    console.error('Error fetching tags:', err);
  } else {
    console.log(JSON.stringify(msgs, null, 2));
  }
}
check();


import { StatusPageContent } from '../components/StatusPageContent';

export default async function StatusPage() {
    return (
        <StatusPageContent />
    );
}

export const getConfig = async () => {
    return {
        render: 'static',
    } as const;
};
